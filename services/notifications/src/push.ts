import type { Notification, UserId } from "@supreme/domain-model";

/**
 * Push notifications (§13) — OPTIONAL, with graceful on-LAN degrade. Notifications
 * always fan out over WSS to connected clients; push additionally reaches devices that
 * are backgrounded/offline. Reaching APNs/FCM needs internet + credentials, so it runs
 * through the optional cloud relay (or a direct provider) behind {@link IPushProvider}.
 * With no provider configured, push is simply off and WSS delivery is unaffected.
 */
export type PushPlatform = "fcm" | "apns" | "webpush";

export interface PushToken {
  id: string;
  userId: UserId;
  platform: PushPlatform;
  token: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface IPushTokenStore {
  /** Upsert a device's push token (keyed by the token string). */
  register(token: PushToken): Promise<void>;
  /** Remove a token — scoped to its owner so one user can't unregister another's device. */
  remove(userId: UserId, token: string): Promise<void>;
  listForUser(userId: UserId): Promise<PushToken[]>;
  listAll(): Promise<PushToken[]>;
}

export class InMemoryPushTokenStore implements IPushTokenStore {
  private readonly byToken = new Map<string, PushToken>();
  async register(token: PushToken) {
    this.byToken.set(token.token, token);
  }
  async remove(userId: UserId, token: string) {
    if (this.byToken.get(token)?.userId === userId) this.byToken.delete(token);
  }
  async listForUser(userId: UserId) {
    return [...this.byToken.values()].filter((t) => t.userId === userId);
  }
  async listAll() {
    return [...this.byToken.values()];
  }
}

/**
 * §Phase13.2 §7 — the minimal, non-authoritative routing envelope carried in every push
 * message's `data` payload. Deliberately carries ONLY what a client needs to identify and
 * de-duplicate an event and decide whether to wake/notify — never a credential, never
 * authoritative device state (the Hub's own `/v1/stream`/REST routes remain the sole source of
 * truth once the client acts on this). `hubId` is the canonical routing identifier (never a
 * display name); `eventId` + `hubId` together are the SAME dedup key shape
 * `HomeEvent.dedupKey` already uses client-side (`apps/new/shared/lib/src/runtime/home_event.dart`),
 * so a push notification for an event the client already received over `/v1/stream` (or a
 * duplicate push retry) is naturally suppressed by the EXISTING dedup mechanism — no second
 * dedup system.
 */
export interface PushEnvelope {
  /** Envelope schema version — bump only on a breaking shape change. */
  v: 1;
  /** Canonical Hub identity this event belongs to — never a display name (§3/§4). */
  hubId: string;
  /** Stable per-event id, paired with `hubId` for the client's existing dedup key. */
  eventId: string;
  /** ISO-8601 timestamp of the underlying event, for client-side ordering/display only. */
  ts: string;
}

export interface PushMessage {
  title: string;
  body: string;
  level: Notification["level"];
  data: Record<string, string>;
}

export interface IPushProvider {
  /** Whether this provider can deliver to the given platform. */
  supports(platform: PushPlatform): boolean;
  /** Deliver a message to one device token. Throws on failure (callers tolerate it). */
  send(token: PushToken, message: PushMessage): Promise<void>;
}

/**
 * Forwards push to the optional Supreme Cloud relay, which holds the FCM/APNs/WebPush
 * credentials and does the actual delivery (blueprint §13: push via optional cloud).
 * The hub never needs provider secrets. `fetchImpl` is injectable for tests.
 */
export interface RelayPushOptions {
  url: string;
  /** Bearer token the cloud relay authenticates the hub with. */
  authToken?: string;
  fetchImpl?: typeof fetch;
}

export class RelayPushProvider implements IPushProvider {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: RelayPushOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }
  supports(): boolean {
    return true; // the relay fans out to every platform
  }
  async send(token: PushToken, message: PushMessage): Promise<void> {
    const res = await this.fetchImpl(this.opts.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.authToken ? { authorization: `Bearer ${this.opts.authToken}` } : {}),
      },
      body: JSON.stringify({ platform: token.platform, token: token.token, message }),
    });
    if (!res.ok) throw new Error(`push relay ${res.status}`);
  }
}

/**
 * Bridges created notifications to push. The gateway calls {@link deliver} from the
 * notification stream; tokens are resolved per-recipient (or all, for broadcasts) and
 * each is sent best-effort through the first provider that supports its platform.
 */
export class PushService {
  constructor(
    private readonly store: IPushTokenStore,
    private readonly providers: IPushProvider[] = [],
    /** §Phase13.2 §7/§11 — this Hub's own canonical identity, stamped into every envelope's
     * `hubId` so a Mobile with multiple paired Homes can route/dedup/authorize the notification
     * correctly (never inferred from the notification content itself). */
    private readonly hubId?: string,
  ) {}

  /** True when at least one push provider is configured (otherwise WSS-only). */
  get enabled(): boolean {
    return this.providers.length > 0;
  }

  async deliver(n: Notification): Promise<number> {
    if (this.providers.length === 0) return 0;
    const tokens = n.userId ? await this.store.listForUser(n.userId) : await this.store.listAll();
    const envelope: Partial<PushEnvelope> = this.hubId
      ? { v: 1, hubId: this.hubId, eventId: n.id, ts: n.createdAt }
      : {};
    const message: PushMessage = {
      title: n.title,
      body: n.body,
      level: n.level,
      data: {
        notificationId: n.id,
        level: n.level,
        ...Object.fromEntries(
          Object.entries(envelope).map(([k, v]) => [k, String(v)]),
        ),
      },
    };
    let sent = 0;
    for (const t of tokens) {
      const provider = this.providers.find((p) => p.supports(t.platform));
      if (!provider) continue;
      try {
        await provider.send(t, message);
        sent++;
      } catch {
        // Best-effort: one device failing must not block the others (or WSS delivery).
      }
    }
    return sent;
  }
}
