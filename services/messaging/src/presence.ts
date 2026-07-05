/**
 * Ephemeral / presence store seam (§5). Redis owns short-lived state — who is
 * connected right now, last-seen, optimistic flags — that must be shared across
 * gateway processes but is NOT the system of record (durable sessions live in
 * Postgres). Default = {@link InMemoryPresenceStore} (dev/tests, single process);
 * production swaps {@link RedisPresenceStore} in with no caller change.
 */
export interface IPresenceStore {
  /** Record a user as connected (a WSS connection opened). TTL-refreshed by heartbeats. */
  markOnline(homeId: string, userId: string, ttlSeconds?: number): Promise<void>;
  /** Drop a user's presence (last WSS connection closed). */
  markOffline(homeId: string, userId: string): Promise<void>;
  /** Distinct user ids currently present in the home. */
  online(homeId: string): Promise<string[]>;
  close(): Promise<void>;
}

const DEFAULT_TTL = 90;

/** In-memory presence with TTL expiry. Single-process only. */
export class InMemoryPresenceStore implements IPresenceStore {
  // homeId → (userId → expiry epoch ms)
  private readonly homes = new Map<string, Map<string, number>>();

  async markOnline(homeId: string, userId: string, ttlSeconds = DEFAULT_TTL): Promise<void> {
    let m = this.homes.get(homeId);
    if (!m) {
      m = new Map();
      this.homes.set(homeId, m);
    }
    m.set(userId, Date.now() + ttlSeconds * 1000);
  }

  async markOffline(homeId: string, userId: string): Promise<void> {
    this.homes.get(homeId)?.delete(userId);
  }

  async online(homeId: string): Promise<string[]> {
    const m = this.homes.get(homeId);
    if (!m) return [];
    const now = Date.now();
    const live: string[] = [];
    for (const [userId, expiry] of m) {
      if (expiry > now) live.push(userId);
      else m.delete(userId);
    }
    return live;
  }

  async close(): Promise<void> {
    this.homes.clear();
  }
}

// Minimal structural type for the slice of `redis` we use (dynamically imported).
interface RedisClient {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  sAdd(key: string, member: string): Promise<unknown>;
  sRem(key: string, member: string): Promise<unknown>;
  sMembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
}
interface RedisModule {
  createClient(opts: { url: string }): RedisClient;
}

export interface RedisPresenceOptions {
  /** e.g. "redis://redis:6379". */
  url: string;
}

/**
 * Redis-backed presence. A per-home set of online user ids, TTL-refreshed on each
 * `markOnline` so a crashed process's entries expire instead of lingering. `redis`
 * is an optional dependency loaded dynamically (ships in the hub image).
 */
export class RedisPresenceStore implements IPresenceStore {
  private constructor(private readonly client: RedisClient) {}

  static async connect(opts: RedisPresenceOptions): Promise<RedisPresenceStore> {
    const moduleName = "redis";
    const redis = (await import(moduleName)) as unknown as RedisModule;
    const client = redis.createClient({ url: opts.url });
    await client.connect();
    return new RedisPresenceStore(client);
  }

  private key(homeId: string): string {
    return `supreme:presence:${homeId}`;
  }

  async markOnline(homeId: string, userId: string, ttlSeconds = DEFAULT_TTL): Promise<void> {
    const key = this.key(homeId);
    await this.client.sAdd(key, userId);
    await this.client.expire(key, ttlSeconds);
  }

  async markOffline(homeId: string, userId: string): Promise<void> {
    await this.client.sRem(this.key(homeId), userId);
  }

  async online(homeId: string): Promise<string[]> {
    return this.client.sMembers(this.key(homeId));
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
