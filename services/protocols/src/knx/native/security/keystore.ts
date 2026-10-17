/**
 * Encrypted local secret store (§ KNX Secure — key storage). A SupremeOS-designed container,
 * NOT a KNX-defined format: it holds opaque named secrets (e.g. imported keyring material)
 * at rest on a local hub with no cloud dependency.
 *
 *   - scrypt(unlock secret, random salt) → 256-bit key; AES-256-GCM over the whole payload
 *     (names included); the header (version, KDF params, salt, UNLOCK MODE, GENERATION) is
 *     bound as AAD, so none of it can be altered without detection
 *   - unlock mode is fixed at creation: a store can only be opened through the same
 *     provider mode — never "retry with something weaker"
 *   - file mode 0600 / dir 0700; refuses to open if group/other can read
 *   - atomic write (temp + fsync + rename) under an exclusive lock file; a second writer
 *     fails fast with `store_busy`, and a writer whose copy is out of date fails with
 *     `stale_store` instead of clobbering another process's update (lost-update protection)
 *   - every mutation emits a value-free audit event
 *
 * NOT provided (do not claim): rollback resistance. The generation counter detects
 * concurrent updates, but an attacker (or a restore) who replaces the whole file with an
 * older valid copy is undetectable without a trusted monotonic counter outside the file.
 * Also not provided: protection from a compromised running process/root, memory
 * zeroisation guarantees, TPM binding (see unlock.ts).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hostname } from "node:os";
import { Secret } from "./secret.js";
import { PassphraseUnlockProvider, UnlockError, type KeyUnlockProvider, type UnlockMode } from "./unlock.js";

export type KeyStoreErrorCode =
  | "exists" | "not_found" | "locked_or_corrupt" | "unsafe_permissions" | "unsupported_version" | "invalid_input"
  | "no_such_secret" | "unlock_mode_mismatch" | "store_busy" | "stale_store";

export class KeyStoreError extends Error {
  constructor(readonly code: KeyStoreErrorCode, message: string) {
    super(message);
    this.name = "KeyStoreError";
  }
}

export interface AuditEvent {
  at: string;
  action: "create" | "open" | "open_failed" | "put" | "delete" | "rotate_passphrase" | "replace_all" | "import_rejected" | "import_activated";
  actor: string;
  /** Secret NAME only — never a value. */
  name?: string;
  result: "ok" | "denied" | "error";
  detail?: string;
}
export type AuditSink = (e: AuditEvent) => void;

export interface KeyStoreOptions {
  path: string;
  /** Who is performing operations, recorded in audit events (e.g. an installer account id). */
  actor: string;
  audit?: AuditSink;
  now?: () => Date;
  /** Test hook only: lower scrypt cost. Production default is N=2^15. */
  scryptN?: number;
  /** TEST-ONLY fault injection, used to exercise interrupted/failed writes deterministically
   * (including as root, where permission-based failures cannot be produced). */
  faultInjection?: { afterTempWrite?: () => void; beforeRename?: () => void };
}

const VERSION = 2;
const DEFAULT_N = 1 << 15;
const NAME_RE = /^[A-Za-z0-9._:\/-]{1,128}$/;
const MAX_SECRET_BYTES = 4096;

interface Envelope { v: number; kdf: "scrypt"; N: number; r: number; p: number; salt: string; unlock: UnlockMode; gen: number; iv: string; tag: string; ct: string }

export class KeyStore {
  private closed = false;

  private constructor(
    private readonly o: KeyStoreOptions,
    private readonly mode: UnlockMode,
    private pass: Secret,
    private entries: Map<string, Secret>,
    private gen: number,
  ) {}

  // ---- construction -------------------------------------------------------------------

  /** Passphrase-mode convenience (sync). */
  static create(o: KeyStoreOptions, passphrase: Secret): KeyStore {
    return KeyStore.build(o, new PassphraseUnlockProvider(passphrase).obtain(), "passphrase");
  }
  static open(o: KeyStoreOptions, passphrase: Secret): KeyStore {
    return KeyStore.load(o, new PassphraseUnlockProvider(passphrase).obtain(), "passphrase");
  }

  /** Provider-based creation/open (any mode). A provider failure is final: no other mode is tried. */
  static async createWith(o: KeyStoreOptions, provider: KeyUnlockProvider): Promise<KeyStore> {
    const secret = await KeyStore.obtain(o, provider);
    return KeyStore.build(o, secret, provider.mode);
  }
  static async openWith(o: KeyStoreOptions, provider: KeyUnlockProvider): Promise<KeyStore> {
    const secret = await KeyStore.obtain(o, provider);
    return KeyStore.load(o, secret, provider.mode);
  }

  private static async obtain(o: KeyStoreOptions, provider: KeyUnlockProvider): Promise<Secret> {
    try { return await provider.obtain(); } catch (e) {
      audit(o, "open_failed", "denied", undefined, e instanceof UnlockError ? e.code : "unlock_failed");
      throw e;
    }
  }

  private static build(o: KeyStoreOptions, secret: Secret, mode: UnlockMode): KeyStore {
    if (existsSync(o.path)) { audit(o, "create", "denied", undefined, "store already exists"); throw new KeyStoreError("exists", "key store already exists; refusing to overwrite"); }
    mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 });
    const ks = new KeyStore(o, mode, new Secret(secret.use((b) => b)), new Map(), 0);
    ks.persist(ks.entries);
    audit(o, "create", "ok", undefined, `unlock=${mode}`);
    return ks;
  }

  private static load(o: KeyStoreOptions, secret: Secret, mode: UnlockMode): KeyStore {
    if (!existsSync(o.path)) throw new KeyStoreError("not_found", "key store does not exist");
    if (process.platform !== "win32" && (statSync(o.path).mode & 0o077) !== 0) {
      audit(o, "open_failed", "denied", undefined, "unsafe file permissions");
      throw new KeyStoreError("unsafe_permissions", "key store is accessible to group/other; fix permissions (chmod 600) before use");
    }
    let env: Envelope;
    try { env = JSON.parse(readFileSync(o.path, "utf8")) as Envelope; } catch {
      audit(o, "open_failed", "error", undefined, "unreadable");
      throw new KeyStoreError("locked_or_corrupt", "key store is unreadable");
    }
    if (env.v !== VERSION || env.kdf !== "scrypt") throw new KeyStoreError("unsupported_version", `unsupported key store version ${String(env.v)}`);
    if (env.unlock !== mode) {
      audit(o, "open_failed", "denied", undefined, `unlock mode mismatch (store=${String(env.unlock)}, requested=${mode})`);
      throw new KeyStoreError("unlock_mode_mismatch", `this store is protected with unlock mode "${String(env.unlock)}"; "${mode}" cannot open it and no fallback is attempted`);
    }
    try {
      const plain = decrypt(env, secret);
      const parsed = JSON.parse(plain.toString("utf8")) as Record<string, string>;
      plain.fill(0);
      const entries = new Map<string, Secret>();
      for (const [k, v] of Object.entries(parsed)) entries.set(k, new Secret(Buffer.from(v, "base64")));
      audit(o, "open", "ok", undefined, `unlock=${mode}`);
      return new KeyStore(o, mode, new Secret(secret.use((b) => b)), entries, env.gen);
    } catch {
      // One message for wrong secret and tampering alike: no oracle.
      audit(o, "open_failed", "denied", undefined, "authentication failed");
      throw new KeyStoreError("locked_or_corrupt", "cannot unlock key store: wrong secret or the file was modified");
    }
  }

  // ---- reads --------------------------------------------------------------------------

  get unlockMode(): UnlockMode { return this.mode; }
  get generation(): number { return this.gen; }
  names(): string[] { this.live(); return [...this.entries.keys()].sort(); }

  /** Returns an independent copy; the caller owns it and should `wipe()` when finished. */
  get(name: string): Secret {
    this.live();
    const s = this.entries.get(name);
    if (!s) throw new KeyStoreError("no_such_secret", `no secret named "${name}"`);
    return new Secret(s.use((b) => b));
  }

  // ---- mutations (each is atomic and fully rolled back on failure) ---------------------

  put(name: string, secret: Secret): void {
    this.live();
    checkName(name);
    checkSize(secret);
    this.commit((draft) => { draft.set(name, new Secret(secret.use((b) => b))); }, "put", name);
  }

  delete(name: string): void {
    this.live();
    if (!this.entries.has(name)) throw new KeyStoreError("no_such_secret", `no secret named "${name}"`);
    this.commit((draft) => { draft.delete(name); }, "delete", name);
  }

  /** Atomically replaces the whole secret set (used by validated keyring activation). */
  replaceAll(next: ReadonlyMap<string, Secret>): void {
    this.live();
    for (const [n, s] of next) { checkName(n); checkSize(s); }
    this.commit((draft) => { draft.clear(); for (const [n, s] of next) draft.set(n, new Secret(s.use((b) => b))); }, "replace_all");
  }

  rotatePassphrase(next: Secret): void {
    this.live();
    if (this.mode !== "passphrase") throw new KeyStoreError("invalid_input", `rotation of a "${this.mode}" store must go through its unlock provider's own procedure`);
    if (next.wiped || next.length < 12) throw new KeyStoreError("invalid_input", "passphrase must be at least 12 bytes; there is no default passphrase");
    const old = this.pass;
    this.pass = new Secret(next.use((b) => b));
    try { this.persist(this.entries); } catch (e) { this.pass.wipe(); this.pass = old; audit(this.o, "rotate_passphrase", "error", undefined, errCode(e)); throw e; }
    old.wipe();
    audit(this.o, "rotate_passphrase", "ok");
  }

  /** Records a value-free audit event for an operation performed around the store. */
  recordAudit(action: "import_rejected" | "import_activated", result: AuditEvent["result"], detail: string): void {
    audit(this.o, action, result, undefined, detail);
  }

  /** Wipes in-memory copies. The store object is unusable afterwards. */
  close(): void {
    for (const s of this.entries.values()) s.wipe();
    this.entries.clear();
    this.pass.wipe();
    this.closed = true;
  }

  // ---- internals ----------------------------------------------------------------------

  private live(): void { if (this.closed) throw new KeyStoreError("invalid_input", "key store is closed"); }

  private commit(mutate: (draft: Map<string, Secret>) => void, action: AuditEvent["action"], name?: string): void {
    const draft = new Map<string, Secret>();
    for (const [k, v] of this.entries) draft.set(k, new Secret(v.use((b) => b)));
    mutate(draft);
    try { this.persist(draft); } catch (e) {
      for (const s of draft.values()) s.wipe();
      audit(this.o, action, "error", name, errCode(e));
      throw e; // in-memory state untouched: `this.entries` is still the last persisted set
    }
    const old = this.entries;
    this.entries = draft;
    for (const s of old.values()) s.wipe();
    audit(this.o, action, "ok", name);
  }

  private persist(set: Map<string, Secret>): void {
    this.withLock(() => {
      if (existsSync(this.o.path)) {
        let onDisk: number;
        try { onDisk = (JSON.parse(readFileSync(this.o.path, "utf8")) as Envelope).gen; } catch { throw new KeyStoreError("locked_or_corrupt", "key store on disk is unreadable; refusing to overwrite it"); }
        if (onDisk !== this.gen) throw new KeyStoreError("stale_store", `store changed on disk (generation ${onDisk}, this copy ${this.gen}); reopen it before changing anything`);
      }
      this.removeStaleTemps();
      const payload: Record<string, string> = {};
      for (const [k, v] of set) payload[k] = v.use((b) => b.toString("base64"));
      const plain = Buffer.from(JSON.stringify(payload), "utf8");
      const env = encrypt(plain, this.pass, this.o.scryptN ?? DEFAULT_N, this.mode, this.gen + 1);
      plain.fill(0);
      const tmp = `${this.o.path}.${randomBytes(4).toString("hex")}.tmp`;
      const fd = openSync(tmp, "wx", 0o600);
      try { writeSync(fd, JSON.stringify(env)); fsyncSync(fd); } finally { closeSync(fd); }
      try {
        this.o.faultInjection?.afterTempWrite?.();
        this.o.faultInjection?.beforeRename?.();
        renameSync(tmp, this.o.path);
      } catch (e) { try { unlinkSync(tmp); } catch { /* already gone */ } throw e; }
      this.gen += 1;
    });
  }

  /** Temp files from an interrupted earlier write; safe to remove while we hold the lock. */
  private removeStaleTemps(): void {
    const dir = dirname(this.o.path), base = basename(this.o.path);
    for (const f of readdirSync(dir)) {
      if (f.startsWith(`${base}.`) && f.endsWith(".tmp")) { try { unlinkSync(join(dir, f)); } catch { /* best effort */ } }
    }
  }

  private withLock<T>(fn: () => T): T {
    const lock = `${this.o.path}.lock`;
    const take = (): number => openSync(lock, "wx", 0o600);
    let fd: number;
    try { fd = take(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (!lockIsStale(lock)) throw new KeyStoreError("store_busy", "another process is updating the key store; try again");
      try { unlinkSync(lock); fd = take(); } catch { throw new KeyStoreError("store_busy", "another process is updating the key store; try again"); }
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: (this.o.now?.() ?? new Date()).toISOString() }));
      return fn();
    } finally { closeSync(fd); try { unlinkSync(lock); } catch { /* already removed */ } }
  }
}

/** A lock is reclaimable only if it names THIS host and a process that no longer exists. */
function lockIsStale(lock: string): boolean {
  try {
    const info = JSON.parse(readFileSync(lock, "utf8")) as { pid?: number; host?: string };
    if (info.host !== hostname() || typeof info.pid !== "number") return false;
    try { process.kill(info.pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch { return false; }
}

export function isValidSecretName(name: string): boolean { return NAME_RE.test(name); }
function checkName(name: string): void { if (!NAME_RE.test(name)) throw new KeyStoreError("invalid_input", "invalid secret name"); }
function checkSize(s: Secret): void { if (s.wiped || s.length === 0 || s.length > MAX_SECRET_BYTES) throw new KeyStoreError("invalid_input", `secret size must be 1..${MAX_SECRET_BYTES} bytes`); }
function errCode(e: unknown): string { return e instanceof KeyStoreError ? e.code : "write_failed"; }

function header(e: Pick<Envelope, "v" | "kdf" | "N" | "r" | "p" | "salt" | "unlock" | "gen">): Buffer {
  return Buffer.from(`${e.v}|${e.kdf}|${e.N}|${e.r}|${e.p}|${e.salt}|${e.unlock}|${e.gen}`, "utf8");
}

function deriveKey(pass: Secret, salt: Buffer, N: number, r: number, p: number): Buffer {
  return pass.use((b) => scryptSync(b, salt, 32, { N, r, p, maxmem: 256 * N * r + (1 << 20) }));
}

function encrypt(plain: Buffer, pass: Secret, N: number, unlock: UnlockMode, gen: number): Envelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const base = { v: VERSION, kdf: "scrypt" as const, N, r: 8, p: 1, salt: salt.toString("base64"), unlock, gen };
  const key = deriveKey(pass, salt, N, 8, 1);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(header(base));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  key.fill(0);
  return { ...base, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function decrypt(e: Envelope, pass: Secret): Buffer {
  const key = deriveKey(pass, Buffer.from(e.salt, "base64"), e.N, e.r, e.p);
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
    d.setAAD(header(e));
    d.setAuthTag(Buffer.from(e.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]);
  } finally { key.fill(0); }
}

function audit(o: KeyStoreOptions, action: AuditEvent["action"], result: AuditEvent["result"], name?: string, detail?: string): void {
  o.audit?.({ at: (o.now?.() ?? new Date()).toISOString(), action, actor: o.actor, result, ...(name ? { name } : {}), ...(detail ? { detail } : {}) });
}

/** Constant-time equality of two secrets (used for import diffing). */
export function secretsEqual(a: Secret, b: Secret): boolean {
  return a.use((x) => b.use((y) => x.length === y.length && timingSafeEqual(x, y)));
}
