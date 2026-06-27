import { hash, verify } from "@node-rs/argon2";
import { uuidv7 } from "@supreme/hub-identity";

/**
 * @supreme/cloud-identity — the cloud Identity service (ADR 0007, blueprint §5, §6).
 *
 * Owns accounts and their login handles: email / phone / username identities, the password
 * credential (Argon2id), passkey (WebAuthn) records, and federated-login links (Apple/Google/
 * Microsoft). It is the system of record for "who a Supreme user is"; AuthN turns a verified
 * identity into sessions + tokens, and the hub maps a cloud account to a local principal.
 *
 * Transport-agnostic core with an injectable store seam (Postgres `identity` schema in prod).
 */

export { buildIdentityServer, type IdentityServerOptions } from "./server.js";

export type IdentityKind = "email" | "phone" | "username";
export type FederatedProvider = "apple" | "google" | "microsoft";

export interface Account {
  id: string;
  status: "active" | "suspended" | "closed";
  createdAt: number;
}

export interface Identity {
  id: string;
  accountId: string;
  kind: IdentityKind;
  value: string;
  verifiedAt: number | null;
}

export interface PasskeyRecord {
  id: string;
  accountId: string;
  credentialId: string;
  publicKey: string;
  signCount: number;
  name: string | null;
  createdAt: number;
}

export interface FederatedLink {
  accountId: string;
  provider: FederatedProvider;
  subject: string;
  email: string | null;
}

export interface IIdentityStore {
  putAccount(a: Account): void;
  getAccount(id: string): Account | undefined;
  putIdentity(i: Identity): void;
  getIdentity(kind: IdentityKind, value: string): Identity | undefined;
  setCredential(accountId: string, passwordHash: string): void;
  getCredential(accountId: string): string | undefined;
  putPasskey(p: PasskeyRecord): void;
  listPasskeys(accountId: string): PasskeyRecord[];
  putFederated(link: FederatedLink): void;
  getFederated(provider: FederatedProvider, subject: string): FederatedLink | undefined;
}

export class InMemoryIdentityStore implements IIdentityStore {
  private accounts = new Map<string, Account>();
  private identities = new Map<string, Identity>(); // key: kind|value
  private credentials = new Map<string, string>();
  private passkeys: PasskeyRecord[] = [];
  private federated = new Map<string, FederatedLink>(); // key: provider|subject

  putAccount(a: Account) {
    this.accounts.set(a.id, a);
  }
  getAccount(id: string) {
    return this.accounts.get(id);
  }
  putIdentity(i: Identity) {
    this.identities.set(`${i.kind}|${i.value.toLowerCase()}`, i);
  }
  getIdentity(kind: IdentityKind, value: string) {
    return this.identities.get(`${kind}|${value.toLowerCase()}`);
  }
  setCredential(accountId: string, passwordHash: string) {
    this.credentials.set(accountId, passwordHash);
  }
  getCredential(accountId: string) {
    return this.credentials.get(accountId);
  }
  putPasskey(p: PasskeyRecord) {
    this.passkeys.push(p);
  }
  listPasskeys(accountId: string) {
    return this.passkeys.filter((p) => p.accountId === accountId);
  }
  putFederated(link: FederatedLink) {
    this.federated.set(`${link.provider}|${link.subject}`, link);
  }
  getFederated(provider: FederatedProvider, subject: string) {
    return this.federated.get(`${provider}|${subject}`);
  }
}

export class IdentityError extends Error {
  constructor(
    readonly code: "conflict" | "not_found" | "invalid_credentials",
    message: string,
  ) {
    super(message);
  }
}

// A fixed-cost dummy hash so verifying an unknown identity takes the same time as a known one
// (anti-enumeration). Argon2id encoded string with throwaway parameters.
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c3VwcmVtZS1kdW1teS1zYWx0$Zq0p9m2hF0p1JxqZ2hF0p1JxqZ2hF0p1JxqZ2hF0p0";

export interface IdentityOptions {
  store?: IIdentityStore;
  now?: () => number;
}

export class IdentityService {
  private readonly store: IIdentityStore;
  private readonly now: () => number;

  constructor(opts: IdentityOptions = {}) {
    this.store = opts.store ?? new InMemoryIdentityStore();
    this.now = opts.now ?? (() => Date.now());
  }

  /** Create an account with a primary identity and (optionally) a password. */
  async register(input: {
    kind: IdentityKind;
    value: string;
    password?: string;
  }): Promise<{ account: Account; identity: Identity }> {
    if (this.store.getIdentity(input.kind, input.value)) {
      throw new IdentityError("conflict", `${input.kind} already registered`);
    }
    const account: Account = { id: uuidv7(this.now()), status: "active", createdAt: this.now() };
    this.store.putAccount(account);
    const identity: Identity = {
      id: uuidv7(this.now()),
      accountId: account.id,
      kind: input.kind,
      value: input.value,
      verifiedAt: null,
    };
    this.store.putIdentity(identity);
    if (input.password) await this.setPassword(account.id, input.password);
    return { account, identity };
  }

  /** Add another login handle to an existing account (e.g. add a phone to an email account). */
  addIdentity(accountId: string, kind: IdentityKind, value: string): Identity {
    if (!this.store.getAccount(accountId)) throw new IdentityError("not_found", "account not found");
    if (this.store.getIdentity(kind, value)) throw new IdentityError("conflict", `${kind} already registered`);
    const identity: Identity = { id: uuidv7(this.now()), accountId, kind, value, verifiedAt: null };
    this.store.putIdentity(identity);
    return identity;
  }

  async setPassword(accountId: string, password: string): Promise<void> {
    if (!this.store.getAccount(accountId)) throw new IdentityError("not_found", "account not found");
    this.store.setCredential(accountId, await hash(password));
  }

  /**
   * Verify an identity + password. Runs a constant-cost dummy verification when the identity
   * or credential is missing, so response time can't be used to enumerate accounts.
   */
  async verifyPassword(kind: IdentityKind, value: string, password: string): Promise<string> {
    const identity = this.store.getIdentity(kind, value);
    const stored = identity ? this.store.getCredential(identity.accountId) : undefined;
    const ok = await verify(stored ?? DUMMY_HASH, password).catch(() => false);
    if (!identity || !stored || !ok) throw new IdentityError("invalid_credentials", "invalid credentials");
    return identity.accountId;
  }

  getAccount(id: string): Account | undefined {
    return this.store.getAccount(id);
  }

  resolveIdentity(kind: IdentityKind, value: string): Identity | undefined {
    return this.store.getIdentity(kind, value);
  }

  // ── Federated login (Apple / Google / Microsoft) ───────────────────────────────────────
  /** Look up or create an account for a verified federated subject (account-linking by sub). */
  async upsertFederated(input: {
    provider: FederatedProvider;
    subject: string;
    email?: string;
  }): Promise<{ account: Account; created: boolean }> {
    const existing = this.store.getFederated(input.provider, input.subject);
    if (existing) {
      const account = this.store.getAccount(existing.accountId);
      if (account) return { account, created: false };
    }
    // Link to an existing account by verified email, else create a fresh account.
    let account: Account | undefined;
    if (input.email) {
      const byEmail = this.store.getIdentity("email", input.email);
      if (byEmail) account = this.store.getAccount(byEmail.accountId);
    }
    let created = false;
    if (!account) {
      account = { id: uuidv7(this.now()), status: "active", createdAt: this.now() };
      this.store.putAccount(account);
      if (input.email) {
        this.store.putIdentity({ id: uuidv7(this.now()), accountId: account.id, kind: "email", value: input.email, verifiedAt: this.now() });
      }
      created = true;
    }
    this.store.putFederated({ accountId: account.id, provider: input.provider, subject: input.subject, email: input.email ?? null });
    return { account, created };
  }

  // ── Passkeys (WebAuthn) ────────────────────────────────────────────────────────────────
  registerPasskey(accountId: string, input: { credentialId: string; publicKey: string; name?: string }): PasskeyRecord {
    if (!this.store.getAccount(accountId)) throw new IdentityError("not_found", "account not found");
    const rec: PasskeyRecord = {
      id: uuidv7(this.now()),
      accountId,
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      signCount: 0,
      name: input.name ?? null,
      createdAt: this.now(),
    };
    this.store.putPasskey(rec);
    return rec;
  }

  listPasskeys(accountId: string): PasskeyRecord[] {
    return this.store.listPasskeys(accountId);
  }
}
