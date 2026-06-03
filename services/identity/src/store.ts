import type { Home, User, UserId } from "@supreme/domain-model";

/**
 * Identity persistence boundary. Phase 0 ships an in-memory implementation; the
 * Postgres-backed implementation lands with `infra/hub-compose` Postgres without
 * changing any caller (§5, §16). Credentials are stored separately from the user
 * record so the user object can be returned to clients without secrets.
 */
export interface StoredCredential {
  userId: UserId;
  /** Argon2id hash. */
  passwordHash: string;
  /** Base32 TOTP secret, or null if MFA is not enrolled. */
  mfaSecret: string | null;
}

export interface IIdentityStore {
  getHome(): Promise<Home | null>;
  putHome(home: Home): Promise<void>;
  findUserByEmail(email: string): Promise<User | null>;
  getUser(id: UserId): Promise<User | null>;
  listUsers(): Promise<User[]>;
  putUser(user: User): Promise<void>;
  getCredential(userId: UserId): Promise<StoredCredential | null>;
  putCredential(cred: StoredCredential): Promise<void>;
}

export class InMemoryIdentityStore implements IIdentityStore {
  private home: Home | null = null;
  private readonly users = new Map<UserId, User>();
  private readonly credentials = new Map<UserId, StoredCredential>();

  async getHome(): Promise<Home | null> {
    return this.home;
  }
  async putHome(home: Home): Promise<void> {
    this.home = home;
  }
  async findUserByEmail(email: string): Promise<User | null> {
    const needle = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === needle) return u;
    }
    return null;
  }
  async getUser(id: UserId): Promise<User | null> {
    return this.users.get(id) ?? null;
  }
  async listUsers(): Promise<User[]> {
    return [...this.users.values()];
  }
  async putUser(user: User): Promise<void> {
    this.users.set(user.id, user);
  }
  async getCredential(userId: UserId): Promise<StoredCredential | null> {
    return this.credentials.get(userId) ?? null;
  }
  async putCredential(cred: StoredCredential): Promise<void> {
    this.credentials.set(cred.userId, cred);
  }
}
