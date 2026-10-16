/**
 * Encrypted local secret store (§ KNX Secure — key storage). A SupremeOS-designed container,
 * NOT a KNX-defined format: it holds opaque named secrets (e.g. imported keyring material)
 * at rest on a local hub with no cloud dependency.
 *
 *   - scrypt(passphrase, random salt) → 256-bit key; AES-256-GCM over the whole payload
 *     (names included), header bound as AAD, fresh random IV per write
 *   - file mode 0600 / dir 0700 enforced on create; refuses to open if group/other can read
 *   - atomic write (temp file + fsync + rename), so a crash never leaves a half-written store
 *   - every mutation emits a value-free audit event
 *   - no default passphrase, no bypass: a wrong passphrase or any tampering fails closed
 *
 * Unlock strategy is the caller's: an operator-supplied passphrase or a key file from a
 * protected mount. The passphrase protects against theft of the disk/backup, NOT against a
 * compromised running process or root on the hub. No TPM/HSM binding exists here.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { Secret } from "./secret.js";

export type KeyStoreErrorCode = "exists" | "not_found" | "locked_or_corrupt" | "unsafe_permissions" | "unsupported_version" | "invalid_input" | "no_such_secret";

export class KeyStoreError extends Error {
  constructor(readonly code: KeyStoreErrorCode, message: string) {
    super(message);
    this.name = "KeyStoreError";
  }
}

export interface AuditEvent {
  at: string;
  action: "create" | "open" | "open_failed" | "put" | "delete" | "rotate_passphrase";
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
}

const VERSION = 1;
const DEFAULT_N = 1 << 15;
const NAME_RE = /^[A-Za-z0-9._:\/-]{1,128}$/;
const MAX_SECRET_BYTES = 4096;

interface Envelope { v: number; kdf: "scrypt"; N: number; r: number; p: number; salt: string; iv: string; tag: string; ct: string }

export class KeyStore {
  private constructor(
    private readonly o: KeyStoreOptions,
    private pass: Secret,
    private readonly entries: Map<string, Secret>,
  ) {}

  static create(o: KeyStoreOptions, passphrase: Secret): KeyStore {
    assertPassphrase(passphrase);
    if (existsSync(o.path)) { audit(o, "create", "denied", undefined, "store already exists"); throw new KeyStoreError("exists", "key store already exists; refusing to overwrite"); }
    mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 });
    const ks = new KeyStore(o, new Secret(passphrase.use((b) => b)), new Map());
    ks.persist();
    audit(o, "create", "ok");
    return ks;
  }

  static open(o: KeyStoreOptions, passphrase: Secret): KeyStore {
    assertPassphrase(passphrase);
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
    try {
      const plain = decrypt(env, passphrase);
      const parsed = JSON.parse(plain.toString("utf8")) as Record<string, string>;
      plain.fill(0);
      const entries = new Map<string, Secret>();
      for (const [k, v] of Object.entries(parsed)) entries.set(k, new Secret(Buffer.from(v, "base64")));
      audit(o, "open", "ok");
      return new KeyStore(o, new Secret(passphrase.use((b) => b)), entries);
    } catch {
      // One message for wrong passphrase and tampering alike: no oracle.
      audit(o, "open_failed", "denied", undefined, "authentication failed");
      throw new KeyStoreError("locked_or_corrupt", "cannot unlock key store: wrong passphrase or the file was modified");
    }
  }

  names(): string[] { return [...this.entries.keys()].sort(); }

  put(name: string, secret: Secret): void {
    if (!NAME_RE.test(name)) throw new KeyStoreError("invalid_input", "invalid secret name");
    if (secret.length === 0 || secret.length > MAX_SECRET_BYTES) throw new KeyStoreError("invalid_input", `secret size must be 1..${MAX_SECRET_BYTES} bytes`);
    const prev = this.entries.get(name);
    this.entries.set(name, new Secret(secret.use((b) => b)));
    try { this.persist(); } catch (e) {
      if (prev) this.entries.set(name, prev); else this.entries.delete(name);
      audit(this.o, "put", "error", name, "persist failed");
      throw e;
    }
    prev?.wipe();
    audit(this.o, "put", "ok", name);
  }

  /** Returns an independent copy; the caller owns it and should `wipe()` when finished. */
  get(name: string): Secret {
    const s = this.entries.get(name);
    if (!s) throw new KeyStoreError("no_such_secret", `no secret named "${name}"`);
    return new Secret(s.use((b) => b));
  }

  delete(name: string): void {
    const s = this.entries.get(name);
    if (!s) throw new KeyStoreError("no_such_secret", `no secret named "${name}"`);
    this.entries.delete(name);
    try { this.persist(); } catch (e) { this.entries.set(name, s); audit(this.o, "delete", "error", name, "persist failed"); throw e; }
    s.wipe();
    audit(this.o, "delete", "ok", name);
  }

  rotatePassphrase(next: Secret): void {
    assertPassphrase(next);
    const old = this.pass;
    this.pass = new Secret(next.use((b) => b));
    try { this.persist(); } catch (e) { this.pass.wipe(); this.pass = old; audit(this.o, "rotate_passphrase", "error", undefined, "persist failed"); throw e; }
    old.wipe();
    audit(this.o, "rotate_passphrase", "ok");
  }

  /** Wipes in-memory copies. The store object is unusable afterwards. */
  close(): void {
    for (const s of this.entries.values()) s.wipe();
    this.entries.clear();
    this.pass.wipe();
  }

  private persist(): void {
    const payload: Record<string, string> = {};
    for (const [k, v] of this.entries) payload[k] = v.use((b) => b.toString("base64"));
    const plain = Buffer.from(JSON.stringify(payload), "utf8");
    const env = encrypt(plain, this.pass, this.o.scryptN ?? DEFAULT_N);
    plain.fill(0);
    const tmp = `${this.o.path}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, JSON.stringify(env)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.o.path);
  }
}

function assertPassphrase(p: Secret): void {
  if (p.wiped || p.length < 12) throw new KeyStoreError("invalid_input", "passphrase must be at least 12 bytes; there is no default passphrase");
}

function header(e: Pick<Envelope, "v" | "kdf" | "N" | "r" | "p" | "salt">): Buffer {
  return Buffer.from(`${e.v}|${e.kdf}|${e.N}|${e.r}|${e.p}|${e.salt}`, "utf8");
}

function deriveKey(pass: Secret, salt: Buffer, N: number, r: number, p: number): Buffer {
  return pass.use((b) => scryptSync(b, salt, 32, { N, r, p, maxmem: 256 * N * r + (1 << 20) }));
}

function encrypt(plain: Buffer, pass: Secret, N: number): Envelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const base = { v: VERSION, kdf: "scrypt" as const, N, r: 8, p: 1, salt: salt.toString("base64") };
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
