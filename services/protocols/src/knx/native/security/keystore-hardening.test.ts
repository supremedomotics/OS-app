import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activateImport, type ImportValidator } from "./import-activation.js";
import { KeyStore, KeyStoreError, type AuditEvent } from "./keystore.js";
import { readNativeFlags, NativeFlagError } from "../native-flags.js";
import { KnxSecurityNotImplementedError } from "./policy.js";
import { Secret } from "./secret.js";
import { ExternalKeyFileUnlockProvider, PassphraseUnlockProvider, TpmUnlockProvider, UnlockError, type TpmSealedKeyDriver } from "./unlock.js";

const K1 = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const K2 = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
const PASS = (): Secret => new Secret(Buffer.from("correct horse battery staple"));
let dir: string; let events: AuditEvent[];
const path = (): string => join(dir, "keys", "store.json");
const opts = (extra: object = {}) => ({ path: path(), actor: "installer:test", audit: (e: AuditEvent) => events.push(e), scryptN: 16, ...extra });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "knxks2-")); events = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const keyFile = (bytes = Buffer.alloc(48, 7), mode = 0o600): string => { const f = join(dir, "unlock.key"); writeFileSync(f, bytes, { mode }); chmodSync(f, mode); return f; };

describe("unlock providers: no silent fallback", () => {
  it("a store is bound to the unlock mode it was created with", async () => {
    const f = keyFile();
    (await KeyStore.createWith(opts(), new ExternalKeyFileUnlockProvider(f))).close();
    expect(() => KeyStore.open(opts(), PASS())).toThrow(expect.objectContaining({ code: "unlock_mode_mismatch" }));
    const re = await KeyStore.openWith(opts(), new ExternalKeyFileUnlockProvider(f));
    expect(re.unlockMode).toBe("external_key_file");
    re.close();
    // and the other direction
    rmSync(join(dir, "keys"), { recursive: true });
    KeyStore.create(opts(), PASS()).close();
    await expect(KeyStore.openWith(opts(), new ExternalKeyFileUnlockProvider(f))).rejects.toMatchObject({ code: "unlock_mode_mismatch" });
    expect(events.filter((e) => e.action === "open_failed").length).toBe(2);
  });
  it("the mode field is authenticated: relabelling a store as another mode cannot open it", async () => {
    const f = keyFile();
    (await KeyStore.createWith(opts(), new ExternalKeyFileUnlockProvider(f))).close();
    const env = JSON.parse(readFileSync(path(), "utf8"));
    writeFileSync(path(), JSON.stringify({ ...env, unlock: "passphrase" }), { mode: 0o600 });
    expect(() => KeyStore.open(opts(), new Secret(readFileSync(f)))).toThrow(expect.objectContaining({ code: "locked_or_corrupt" }));
  });
  it("TPM mode with no driver fails closed, creates nothing, and never tries another mode", async () => {
    await expect(KeyStore.createWith(opts(), new TpmUnlockProvider())).rejects.toMatchObject({ code: "tpm_unavailable" });
    expect(existsSync(path())).toBe(false);
  });
  it("TPM seam (FAKE driver — not hardware): works when available, fails closed when unavailable or unseal fails", async () => {
    const good: TpmSealedKeyDriver = { available: async () => true, unseal: async () => new Secret(Buffer.alloc(32, 9)) };
    (await KeyStore.createWith(opts(), new TpmUnlockProvider(good))).close();
    const unavailable: TpmSealedKeyDriver = { available: async () => false, unseal: async () => { throw new Error("unreachable"); } };
    await expect(KeyStore.openWith(opts(), new TpmUnlockProvider(unavailable))).rejects.toMatchObject({ code: "tpm_unavailable" });
    const broken: TpmSealedKeyDriver = { available: async () => true, unseal: async () => { throw new Error("PCR mismatch 00ff secret-detail"); } };
    const err = await KeyStore.openWith(opts(), new TpmUnlockProvider(broken)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnlockError);
    expect((err as UnlockError).code).toBe("tpm_unseal_failed");
    expect((err as Error).message).not.toContain("secret-detail"); // driver detail is not propagated
    const throwing: TpmSealedKeyDriver = { available: async () => { throw new Error("boom"); }, unseal: async () => new Secret(K1) };
    await expect(KeyStore.openWith(opts(), new TpmUnlockProvider(throwing))).rejects.toMatchObject({ code: "tpm_unavailable" });
  });
  it("a passphrase store cannot be opened through the TPM provider, even with a working TPM", async () => {
    KeyStore.create(opts(), PASS()).close();
    const good: TpmSealedKeyDriver = { available: async () => true, unseal: async () => new Secret(Buffer.alloc(32, 9)) };
    await expect(KeyStore.openWith(opts(), new TpmUnlockProvider(good))).rejects.toMatchObject({ code: "unlock_mode_mismatch" });
  });
  it("external key file is validated: perms, symlink, size, missing; and flagged transitional", () => {
    expect(new ExternalKeyFileUnlockProvider("/x").transitional).toBe(true);
    expect(new PassphraseUnlockProvider(PASS()).transitional).toBe(false);
    expect(() => new ExternalKeyFileUnlockProvider(keyFile(Buffer.alloc(48, 1), 0o644)).obtain()).toThrow(expect.objectContaining({ code: "key_file_unsafe" }));
    expect(() => new ExternalKeyFileUnlockProvider(keyFile(Buffer.alloc(8, 1))).obtain()).toThrow(expect.objectContaining({ code: "key_file_invalid" }));
    expect(() => new ExternalKeyFileUnlockProvider(join(dir, "nope")).obtain()).toThrow(expect.objectContaining({ code: "key_file_invalid" }));
    const real = keyFile(); const link = join(dir, "link.key"); symlinkSync(real, link);
    expect(() => new ExternalKeyFileUnlockProvider(link).obtain()).toThrow(expect.objectContaining({ code: "key_file_unsafe" }));
    expect(new ExternalKeyFileUnlockProvider(real).obtain().length).toBe(48);
  });
});

describe("concurrency and stale copies", () => {
  it("a second handle with an out-of-date copy cannot overwrite a newer update", () => {
    const a = KeyStore.create(opts(), PASS()); a.put("one", new Secret(K1));
    const b = KeyStore.open(opts(), PASS());
    a.put("two", new Secret(K2)); // a moves the store forward
    expect(() => b.put("three", new Secret(K1))).toThrow(expect.objectContaining({ code: "stale_store" }));
    a.close(); b.close();
    const re = KeyStore.open(opts(), PASS());
    expect(re.names()).toEqual(["one", "two"]); // b's write did not clobber a's
    re.close();
  });
  it("generation increases with every committed write and survives reopen", () => {
    const a = KeyStore.create(opts(), PASS());
    expect(a.generation).toBe(1);
    a.put("x", new Secret(K1)); a.delete("x");
    expect(a.generation).toBe(3);
    a.close();
    const re = KeyStore.open(opts(), PASS()); expect(re.generation).toBe(3); re.close();
  });
  it("a held lock makes a concurrent writer fail fast (store_busy) without corrupting anything", () => {
    const a = KeyStore.create(opts(), PASS());
    writeFileSync(`${path()}.lock`, JSON.stringify({ pid: process.pid, host: hostname(), at: "now" }), { mode: 0o600 });
    const before = readFileSync(path(), "utf8");
    expect(() => a.put("x", new Secret(K1))).toThrow(expect.objectContaining({ code: "store_busy" }));
    expect(readFileSync(path(), "utf8")).toBe(before);
    expect(a.names()).toEqual([]);
    rmSync(`${path()}.lock`);
    a.put("x", new Secret(K1)); a.close();
  });
  it("reclaims a lock only when it names this host and a process that no longer exists", () => {
    const a = KeyStore.create(opts(), PASS());
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    writeFileSync(`${path()}.lock`, JSON.stringify({ pid: dead, host: hostname(), at: "then" }), { mode: 0o600 });
    a.put("x", new Secret(K1)); // reclaimed
    writeFileSync(`${path()}.lock`, JSON.stringify({ pid: dead, host: "some-other-host", at: "then" }), { mode: 0o600 });
    expect(() => a.put("y", new Secret(K1))).toThrow(expect.objectContaining({ code: "store_busy" })); // foreign host: never assume dead
    writeFileSync(`${path()}.lock`, "garbage", { mode: 0o600 });
    expect(() => a.put("y", new Secret(K1))).toThrow(expect.objectContaining({ code: "store_busy" })); // unparseable: never reclaim
    a.close();
  });
});

describe("interrupted and corrupted stores", () => {
  it("a crash between temp write and rename leaves the committed store valid and the orphan temp is harmless", () => {
    let crash = false;
    const o = opts({ faultInjection: { afterTempWrite: () => { if (crash) throw new Error("power loss"); } } });
    const a = KeyStore.create(o, PASS()); a.put("safe", new Secret(K1));
    const committed = readFileSync(path(), "utf8");
    crash = true;
    expect(() => a.put("lost", new Secret(K2))).toThrow(/power loss/);
    expect(readFileSync(path(), "utf8")).toBe(committed);
    a.close();
    const re = KeyStore.open(opts(), PASS());
    expect(re.names()).toEqual(["safe"]);
    re.close();
  });
  it("orphaned temp files from a previous crash are ignored on open and removed on the next write", () => {
    const a = KeyStore.create(opts(), PASS()); a.put("k", new Secret(K1));
    writeFileSync(`${path()}.deadbeef.tmp`, "half written garbage");
    a.close();
    const re = KeyStore.open(opts(), PASS());
    expect(re.names()).toEqual(["k"]);
    re.put("k2", new Secret(K2));
    expect(readdirSync(join(dir, "keys"))).toEqual(["store.json"]);
    re.close();
  });
  it("rejects truncated, non-JSON, wrong-version and field-tampered files with typed errors", () => {
    KeyStore.create(opts(), PASS()).close();
    const good = readFileSync(path(), "utf8");
    const env = JSON.parse(good);
    const cases: Array<[string, string, string]> = [
      ["truncated", good.slice(0, good.length / 2), "locked_or_corrupt"],
      ["empty", "", "locked_or_corrupt"],
      ["not json", "\u0000\u0001binary", "locked_or_corrupt"],
      ["wrong version", JSON.stringify({ ...env, v: 1 }), "unsupported_version"],
      ["gen edited (AAD)", JSON.stringify({ ...env, gen: env.gen + 5 }), "locked_or_corrupt"],
      ["kdf params edited (AAD)", JSON.stringify({ ...env, p: 2 }), "locked_or_corrupt"],
    ];
    for (const [label, content, code] of cases) {
      writeFileSync(path(), content, { mode: 0o600 });
      expect(() => KeyStore.open(opts(), PASS()), label).toThrow(expect.objectContaining({ code }));
    }
  });
  it("KNOWN LIMITATION (asserted so it cannot be forgotten): a restored older valid copy is accepted — no rollback resistance", () => {
    const a = KeyStore.create(opts(), PASS()); a.put("old", new Secret(K1));
    copyFileSync(path(), join(dir, "backup.json")); chmodSync(join(dir, "backup.json"), 0o600);
    a.put("new", new Secret(K2)); a.close();
    copyFileSync(join(dir, "backup.json"), path());
    const re = KeyStore.open(opts(), PASS());
    expect(re.names()).toEqual(["old"]); // stale copy silently accepted
    expect(re.generation).toBe(2);
    re.close();
  });
});

describe("secret lifetime", () => {
  it("put copies the caller's bytes; get returns independent copies; close makes the store unusable", () => {
    const src = Buffer.from(K1);
    const ks = KeyStore.create(opts(), PASS());
    ks.put("k", new Secret(src));
    src.fill(0);
    const g1 = ks.get("k"); g1.wipe();
    expect(ks.get("k").use((b) => b.equals(K1))).toBe(true); // wiping a copy never damages the store
    ks.close();
    expect(() => ks.get("k")).toThrow(KeyStoreError);
    expect(() => ks.put("z", new Secret(K1))).toThrow(KeyStoreError);
    expect(() => ks.names()).toThrow(KeyStoreError);
  });
});

describe("transactional import activation (format-agnostic)", () => {
  const cand = (o: Record<string, Buffer>): Map<string, Secret> => new Map(Object.entries(o).map(([k, v]) => [k, new Secret(v)]));
  const needsGa: ImportValidator = (c) => (c.has("ga/1-1-1") ? [] : [{ severity: "error", code: "missing_ga_key", message: "GA key missing" }]);

  it("a failing validator rejects the import and leaves the store byte-for-byte untouched", () => {
    const ks = KeyStore.create(opts(), PASS()); ks.put("keep", new Secret(K1));
    const before = readFileSync(path(), "utf8"); const gen = ks.generation;
    const r = activateImport(ks, cand({ "gw/user": K2 }), [needsGa], () => true);
    expect(r).toMatchObject({ activated: false, reason: "validation_failed" });
    expect(readFileSync(path(), "utf8")).toBe(before);
    expect(ks.generation).toBe(gen);
    expect(events.at(-1)).toMatchObject({ action: "import_rejected", detail: "validation_failed:missing_ga_key" });
    ks.close();
  });
  it("requires explicit confirmation of the diff before anything changes", () => {
    const ks = KeyStore.create(opts(), PASS()); ks.put("a", new Secret(K1));
    let seen: unknown;
    const r = activateImport(ks, cand({ a: K2, b: K1 }), [], (d) => { seen = d; return false; });
    expect(r.reason).toBe("not_confirmed");
    expect(seen).toEqual({ added: ["b"], removed: [], changed: ["a"], unchanged: [] });
    expect(ks.get("a").use((x) => x.equals(K1))).toBe(true);
    ks.close();
  });
  it("activates atomically, reports the diff, and audits counts only", () => {
    const ks = KeyStore.create(opts(), PASS()); ks.put("gone", new Secret(K1)); ks.put("same", new Secret(K1));
    const r = activateImport(ks, cand({ same: K1, "ga/1-1-1": K2 }), [needsGa], () => true);
    expect(r).toMatchObject({ activated: true, reason: "activated", diff: { added: ["ga/1-1-1"], removed: ["gone"], changed: [], unchanged: ["same"] } });
    expect(ks.names()).toEqual(["ga/1-1-1", "same"]);
    expect(events.at(-1)).toMatchObject({ action: "import_activated", detail: "added=1,removed=1,changed=0" });
    expect(JSON.stringify(events)).not.toContain(K2.toString("hex"));
    ks.close();
  });
  it("a failed write during activation leaves the previous set intact", () => {
    let fail = false;
    const ks = KeyStore.create(opts({ faultInjection: { beforeRename: () => { if (fail) throw new Error("disk full"); } } }), PASS());
    ks.put("old", new Secret(K1)); fail = true;
    const r = activateImport(ks, cand({ fresh: K2 }), [], () => true);
    expect(r).toMatchObject({ activated: false, reason: "write_failed" });
    fail = false;
    expect(ks.names()).toEqual(["old"]);
    ks.close();
    const re = KeyStore.open(opts(), PASS()); expect(re.names()).toEqual(["old"]); re.close();
  });
  it("rejects empty candidates, invalid names/sizes and crashing validators; reports no-op imports", () => {
    const ks = KeyStore.create(opts(), PASS()); ks.put("a", new Secret(K1));
    expect(activateImport(ks, cand({}), [], () => true).reason).toBe("empty_candidate");
    expect(activateImport(ks, cand({ "bad name": K1 }), [], () => true).issues.map((i) => i.code)).toContain("invalid_name");
    expect(activateImport(ks, new Map([["z", new Secret(Buffer.alloc(0))]]), [], () => true).issues.map((i) => i.code)).toContain("invalid_size");
    const crash: ImportValidator = () => { throw new Error(`leak ${K1.toString("hex")}`); };
    const r = activateImport(ks, cand({ a: K2 }), [crash], () => true);
    expect(r.issues.map((i) => i.code)).toContain("validator_crashed");
    expect(JSON.stringify(r)).not.toContain(K1.toString("hex")); // a validator's exception text never reaches the result
    expect(activateImport(ks, cand({ a: K1 }), [], () => true).reason).toBe("no_changes");
    ks.close();
  });
});

describe("native feature flags fail closed", () => {
  it("default off; on/off accepted; garbage is an error, never a guess", () => {
    expect(readNativeFlags({})).toEqual({ native: false, secure: false });
    expect(readNativeFlags({ SUPREME_KNX_NATIVE: "on" })).toEqual({ native: true, secure: false });
    expect(readNativeFlags({ SUPREME_KNX_NATIVE: "0" }).native).toBe(false);
    expect(() => readNativeFlags({ SUPREME_KNX_NATIVE: "yes please" })).toThrow(NativeFlagError);
  });
  it("secure mode cannot be requested: it needs native, and it is not implemented", () => {
    expect(() => readNativeFlags({ SUPREME_KNX_NATIVE_SECURE: "on" })).toThrow(NativeFlagError);
    expect(() => readNativeFlags({ SUPREME_KNX_NATIVE: "on", SUPREME_KNX_NATIVE_SECURE: "on" })).toThrow(KnxSecurityNotImplementedError);
  });
});
