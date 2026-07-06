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
  /** Unused MFA recovery-code hashes (sha256). One-time backup codes; consumed on use. */
  recoveryCodes?: string[];
}

export interface IIdentityStore {
  getHome(): Promise<Home | null>;
  putHome(home: Home): Promise<void>;
  findUserByEmail(email: string): Promise<User | null>;
  getUser(id: UserId): Promise<User | null>;
  listUsers(): Promise<User[]>;
  putUser(user: User): Promise<void>;
  /** Permanently remove a user + their credential (§ account deletion). */
  deleteUser(id: UserId): Promise<void>;
  getCredential(userId: UserId): Promise<StoredCredential | null>;
  putCredential(cred: StoredCredential): Promise<void>;
}

/**
 * A login session — the unit of revocation. `currentJti` is the position in the
 * refresh-token rotation chain; presenting any other (older) refresh jti is reuse
 * and revokes the whole session (§12 hardening).
 */
export interface Session {
  id: string;
  userId: UserId;
  currentJti: string;
  revoked: boolean;
  createdAt: string;
  /** Origin of the login, for the Security Center's "trusted devices / login history" (§ Security
   * Center). Optional — older sessions predate capture, and a metric with no source stays null. */
  ip?: string | null;
  userAgent?: string | null;
  lastSeenAt?: string | null;
}

export interface ISessionStore {
  create(session: Session): Promise<void>;
  get(id: string): Promise<Session | null>;
  setCurrentJti(id: string, jti: string): Promise<void>;
  revoke(id: string): Promise<void>;
  /** All of a user's sessions (active + revoked), newest first — the login history. */
  listByUser(userId: UserId): Promise<Session[]>;
  /** Record fresh activity on a session (updated on refresh). */
  touch(id: string, lastSeenAt: string): Promise<void>;
}

/**
 * A personal API token (§ Security Center — API tokens): a long-lived credential a user creates for
 * programmatic/API access. Only the sha256 hash is stored; the plaintext is shown once at creation.
 */
export interface ApiTokenRecord {
  id: string;
  homeId: string;
  userId: UserId;
  name: string;
  tokenHash: string;
  /** A short non-secret prefix shown in the UI to identify the token. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export type ApiTokenRecordMeta = Omit<ApiTokenRecord, "tokenHash">;

export interface IApiTokenStore {
  create(rec: ApiTokenRecord): Promise<void>;
  findByHash(hash: string): Promise<ApiTokenRecord | null>;
  listByUser(userId: UserId): Promise<ApiTokenRecordMeta[]>;
  get(userId: UserId, id: string): Promise<ApiTokenRecord | null>;
  revoke(userId: UserId, id: string): Promise<void>;
  touch(id: string, lastUsedAt: string): Promise<void>;
}

export class InMemoryApiTokenStore implements IApiTokenStore {
  private readonly tokens = new Map<string, ApiTokenRecord>();
  async create(rec: ApiTokenRecord): Promise<void> {
    this.tokens.set(rec.id, rec);
  }
  async findByHash(hash: string): Promise<ApiTokenRecord | null> {
    for (const t of this.tokens.values()) if (t.tokenHash === hash) return t;
    return null;
  }
  async listByUser(userId: UserId): Promise<ApiTokenRecordMeta[]> {
    return [...this.tokens.values()]
      .filter((t) => t.userId === userId && !t.revoked)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ tokenHash: _h, ...meta }) => meta);
  }
  async get(userId: UserId, id: string): Promise<ApiTokenRecord | null> {
    const t = this.tokens.get(id);
    return t && t.userId === userId ? t : null;
  }
  async revoke(userId: UserId, id: string): Promise<void> {
    const t = this.tokens.get(id);
    if (t && t.userId === userId) t.revoked = true;
  }
  async touch(id: string, lastUsedAt: string): Promise<void> {
    const t = this.tokens.get(id);
    if (t) t.lastUsedAt = lastUsedAt;
  }
}

/** A registered passkey / WebAuthn credential (§ Security Center — passkeys). */
export interface WebAuthnCredentialRecord {
  id: string;
  userId: UserId;
  /** base64url credential id from the authenticator. */
  credentialId: string;
  publicKeyPem: string;
  signCount: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type WebAuthnCredentialMeta = Omit<WebAuthnCredentialRecord, "publicKeyPem">;

export interface IWebAuthnStore {
  create(rec: WebAuthnCredentialRecord): Promise<void>;
  findByCredentialId(credentialId: string): Promise<WebAuthnCredentialRecord | null>;
  listByUser(userId: UserId): Promise<WebAuthnCredentialMeta[]>;
  get(userId: UserId, id: string): Promise<WebAuthnCredentialRecord | null>;
  updateSignCount(id: string, signCount: number, lastUsedAt: string): Promise<void>;
  remove(userId: UserId, id: string): Promise<void>;
}

export class InMemoryWebAuthnStore implements IWebAuthnStore {
  private readonly creds = new Map<string, WebAuthnCredentialRecord>();
  async create(rec: WebAuthnCredentialRecord): Promise<void> {
    this.creds.set(rec.id, rec);
  }
  async findByCredentialId(credentialId: string): Promise<WebAuthnCredentialRecord | null> {
    for (const c of this.creds.values()) if (c.credentialId === credentialId) return c;
    return null;
  }
  async listByUser(userId: UserId): Promise<WebAuthnCredentialMeta[]> {
    return [...this.creds.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ publicKeyPem: _p, ...meta }) => meta);
  }
  async get(userId: UserId, id: string): Promise<WebAuthnCredentialRecord | null> {
    const c = this.creds.get(id);
    return c && c.userId === userId ? c : null;
  }
  async updateSignCount(id: string, signCount: number, lastUsedAt: string): Promise<void> {
    const c = this.creds.get(id);
    if (c) { c.signCount = signCount; c.lastUsedAt = lastUsedAt; }
  }
  async remove(userId: UserId, id: string): Promise<void> {
    const c = this.creds.get(id);
    if (c && c.userId === userId) this.creds.delete(id);
  }
}

export class InMemorySessionStore implements ISessionStore {
  private readonly sessions = new Map<string, Session>();
  async create(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async get(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }
  async setCurrentJti(id: string, jti: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.currentJti = jti;
  }
  async revoke(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.revoked = true;
  }
  async listByUser(userId: UserId): Promise<Session[]> {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async touch(id: string, lastSeenAt: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = lastSeenAt;
  }
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
  async deleteUser(id: UserId): Promise<void> {
    this.users.delete(id);
    this.credentials.delete(id);
  }
  async getCredential(userId: UserId): Promise<StoredCredential | null> {
    return this.credentials.get(userId) ?? null;
  }
  async putCredential(cred: StoredCredential): Promise<void> {
    this.credentials.set(cred.userId, cred);
  }
}
