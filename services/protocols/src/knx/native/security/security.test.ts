import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyStore, KeyStoreError, type AuditEvent } from "./keystore.js";
import { assertPolicySatisfiable, KnxSecurityNotImplementedError, PLAIN_POLICY } from "./policy.js";
import { redactSecrets, Secret } from "./secret.js";
import { KnxTunnelClient } from "../tunnel-client.js";
import { parseGroupAddress } from "../address.js";
import { ServiceType } from "../knxnetip-frame.js";
import { ManualClock, VirtualActuator, VirtualKnxBus, VirtualKnxInterface, VirtualNetwork, VirtualSender } from "../simulator/index.js";

// Test-only credentials. Deliberately recognisable, never real key material.
const KEY_A = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const PASS = () => new Secret(Buffer.from("correct horse battery staple"));
const FAST = 1 << 4; // low scrypt cost for tests only

let dir: string;
let events: AuditEvent[];
const opts = (extra: object = {}) => ({ path: join(dir, "keys", "store.json"), actor: "installer:test", audit: (e: AuditEvent) => events.push(e), scryptN: FAST, ...extra });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "knxks-")); events = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Secret", () => {
  it("never reveals its value through string, JSON, template, inspect or spread", () => {
    const s = new Secret(KEY_A);
    const all = [String(s), `${s}`, JSON.stringify({ s, nested: { s } }), inspect(s), inspect({ deep: { s } }, { depth: 5 }), JSON.stringify([s])].join("\n");
    expect(all).not.toContain(KEY_A.toString("hex"));
    expect(all).not.toContain(KEY_A.toString("base64"));
    expect(all).toContain("REDACTED");
  });
  it("copies on construction and zeroes on wipe", () => {
    const src = Buffer.from(KEY_A);
    const s = new Secret(src);
    src.fill(0);
    expect(s.use((b) => b.equals(KEY_A))).toBe(true);
    let captured!: Buffer;
    s.use((b) => { captured = b; });
    s.wipe();
    expect(captured.every((x) => x === 0)).toBe(true);
    expect(s.wiped).toBe(true);
    expect(() => s.use(() => 1)).toThrow(/wiped/);
  });
  it("redactSecrets scrubs raw, hex and base64 forms from arbitrary text", () => {
    const s = new Secret(KEY_A);
    const msg = `failed with key ${KEY_A.toString("hex")} / ${KEY_A.toString("base64")} / ${KEY_A.toString("hex").toUpperCase()}`;
    const out = redactSecrets(msg, [s]);
    expect(out).not.toMatch(/00112233|ABEiM0RV|ABEiM/i);
    expect(out.match(/REDACTED/g)).toHaveLength(3);
  });
});

describe("KeyStore at-rest protection", () => {
  it("round-trips secrets, with the file unreadable without the passphrase and containing no plaintext", () => {
    const ks = KeyStore.create(opts(), PASS());
    ks.put("gw/ip-secure/user1", new Secret(KEY_A));
    ks.put("ga/1-2-3", new Secret(Buffer.from("fedcba98765432100123456789abcdef", "hex")));
    ks.close();
    const raw = readFileSync(opts().path, "utf8");
    expect(raw).not.toContain(KEY_A.toString("hex"));
    expect(raw).not.toContain(KEY_A.toString("base64"));
    expect(raw).not.toContain("gw/ip-secure"); // names are encrypted too
    const re = KeyStore.open(opts(), PASS());
    expect(re.names()).toEqual(["ga/1-2-3", "gw/ip-secure/user1"]);
    expect(re.get("gw/ip-secure/user1").use((b) => b.equals(KEY_A))).toBe(true);
    re.close();
  });
  it("creates files 0600 in a 0700 directory", () => {
    KeyStore.create(opts(), PASS()).close();
    expect(statSync(opts().path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "keys")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, "keys"))).toEqual(["store.json"]); // no temp file left behind
  });
  it("fails closed with one indistinguishable error for a wrong passphrase and for tampering", () => {
    KeyStore.create(opts(), PASS()).close();
    const wrong = () => KeyStore.open(opts(), new Secret(Buffer.from("wrong passphrase here!")));
    expect(wrong).toThrow(expect.objectContaining({ code: "locked_or_corrupt" }));
    const env = JSON.parse(readFileSync(opts().path, "utf8"));
    const msgs = new Set<string>();
    for (const field of ["ct", "tag", "iv", "salt", "N"]) {
      const bad = { ...env, [field]: field === "N" ? 32 : Buffer.from("tampered-value-xx").toString("base64") };
      writeFileSync(opts().path, JSON.stringify(bad), { mode: 0o600 });
      try { KeyStore.open(opts(), PASS()); throw new Error("opened tampered store"); } catch (e) { expect(e).toBeInstanceOf(KeyStoreError); msgs.add((e as Error).message); }
    }
    try { wrong(); } catch (e) { msgs.add((e as Error).message); }
    expect(msgs.size).toBe(1);
  });
  it("refuses to open a store that other users can read", () => {
    KeyStore.create(opts(), PASS()).close();
    chmodSync(opts().path, 0o644);
    expect(() => KeyStore.open(opts(), PASS())).toThrow(expect.objectContaining({ code: "unsafe_permissions" }));
  });
  it("has no default passphrase and will not overwrite an existing store", () => {
    expect(() => KeyStore.create(opts(), new Secret(Buffer.from("short")))).toThrow(expect.objectContaining({ code: "passphrase_invalid" }));
    KeyStore.create(opts(), PASS()).close();
    expect(() => KeyStore.create(opts(), PASS())).toThrow(expect.objectContaining({ code: "exists" }));
  });
  it("rotates the passphrase: old fails, new works, data preserved", () => {
    const ks = KeyStore.create(opts(), PASS());
    ks.put("k", new Secret(KEY_A));
    ks.rotatePassphrase(new Secret(Buffer.from("a brand new passphrase")));
    ks.close();
    expect(() => KeyStore.open(opts(), PASS())).toThrow(KeyStoreError);
    const re = KeyStore.open(opts(), new Secret(Buffer.from("a brand new passphrase")));
    expect(re.get("k").use((b) => b.equals(KEY_A))).toBe(true);
    re.close();
  });
  it("rejects invalid names/sizes and unknown lookups, and delete is durable", () => {
    const ks = KeyStore.create(opts(), PASS());
    expect(() => ks.put("bad name!", new Secret(KEY_A))).toThrow(KeyStoreError);
    expect(() => ks.put("ok", new Secret(Buffer.alloc(5000, 1)))).toThrow(KeyStoreError);
    expect(() => ks.get("missing")).toThrow(expect.objectContaining({ code: "no_such_secret" }));
    ks.put("ok", new Secret(KEY_A));
    ks.delete("ok");
    ks.close();
    const re = KeyStore.open(opts(), PASS());
    expect(re.names()).toEqual([]);
    re.close();
  });
  it("audits every mutation and failure, and no audit event, error or detail contains a secret", () => {
    const ks = KeyStore.create(opts(), PASS());
    ks.put("gw/user", new Secret(KEY_A));
    try { ks.get("nope"); } catch { /* expected */ }
    ks.delete("gw/user");
    ks.rotatePassphrase(new Secret(Buffer.from("another long passphrase")));
    ks.close();
    try { KeyStore.open(opts(), PASS()); } catch { /* wrong passphrase after rotation */ }
    expect(events.map((e) => `${e.action}:${e.result}`)).toEqual(["create:ok", "put:ok", "delete:ok", "rotate_passphrase:ok", "open_failed:denied"]);
    expect(events.every((e) => e.actor === "installer:test")).toBe(true);
    const blob = JSON.stringify(events);
    for (const secret of [KEY_A.toString("hex"), KEY_A.toString("base64"), "correct horse", "another long"]) expect(blob).not.toContain(secret);
  });
  it("leaves the previous store intact when a write fails (deterministic fault injection; runs as root too)", () => {
    let fail = false;
    const o = opts({ faultInjection: { beforeRename: () => { if (fail) throw new Error("injected disk failure"); } } });
    const ks = KeyStore.create(o, PASS());
    ks.put("a", new Secret(KEY_A));
    const before = readFileSync(o.path, "utf8");
    fail = true;
    expect(() => ks.put("b", new Secret(KEY_A))).toThrow(/injected/);
    fail = false;
    expect(ks.names()).toEqual(["a"]); // in-memory state unchanged
    expect(readFileSync(o.path, "utf8")).toBe(before); // on-disk bytes unchanged
    expect(readdirSync(join(dir, "keys"))).toEqual(["store.json"]); // temp + lock cleaned up
    ks.put("b", new Secret(KEY_A)); // and the store is still usable
    expect(ks.names()).toEqual(["a", "b"]);
    ks.close();
  });
});

describe("no silent security downgrade", () => {
  const net = () => { const clock = new ManualClock(); return { clock, n: new VirtualNetwork(clock) }; };
  it("plain policy is satisfiable; secure requirements fail closed with an explicit error", () => {
    expect(() => assertPolicySatisfiable(PLAIN_POLICY)).not.toThrow();
    expect(() => assertPolicySatisfiable({ transport: "ip_secure_required", data: "none" })).toThrow(KnxSecurityNotImplementedError);
    expect(() => assertPolicySatisfiable({ transport: "none", data: "data_secure_required" })).toThrow(expect.objectContaining({ code: "secure_not_implemented", feature: "data_secure" }));
  });
  it("a tunnel client declared secure cannot be constructed, so it can never open a plain socket", () => {
    const { n } = net();
    let socketsOpened = 0;
    const factory = n.createSocketFactory("10.0.0.50");
    const counting = (h: Parameters<typeof factory>[0]) => { socketsOpened++; return factory(h); };
    expect(() => new KnxTunnelClient({ host: "10.0.0.2", socketFactory: counting, security: { transport: "ip_secure_required", data: "none" } })).toThrow(KnxSecurityNotImplementedError);
    expect(socketsOpened).toBe(0);
    expect(n.openClientSockets).toBe(0);
  });
  it("group telegrams with a non-plain APCI are counted and withheld, never decoded as values", async () => {
    const clock = new ManualClock(); const n = new VirtualNetwork(clock); const bus = new VirtualKnxBus(clock);
    const gw = new VirtualKnxInterface(n, bus, clock, { address: "10.0.0.2" });
    const ga = parseGroupAddress("1/1/1");
    bus.addDevice(new VirtualActuator({ individualAddress: 0x1101, commandGa: ga, feedbackGa: null, dpt: "1.001", initial: false }, clock));
    const c = new KnxTunnelClient({ host: "10.0.0.2", socketFactory: n.createSocketFactory("10.0.0.50"), clock });
    const p = c.connect(); await clock.advance(5); await p;
    const seen: unknown[] = []; c.onTelegram((f) => seen.push(f));
    // Rewrite the first indication's APDU to APCI 0x3F1 (an application service that is not a group value service).
    n.addRule({ match: (x) => x.service === ServiceType.TUNNELLING_REQUEST && x.from.address === "10.0.0.2", action: "corrupt", times: 1, corrupt: (b) => { b[19] = 0x03; b[20] = 0xf1; return b; } });
    const wall = new VirtualSender(0x1105); bus.addDevice(wall);
    wall.emit(bus, ga, "1.001", true);
    await clock.advance(50);
    expect(seen).toHaveLength(0);
    expect(c.diagnostics().undecodedGroupTelegrams).toBe(1);
    expect(c.state).toBe("connected");
    void c.disconnect(); await clock.advance(10_000); gw.shutdown();
  });
});

describe("simulator isolation", () => {
  it("no production source file imports the simulator", () => {
    const root = join(__dirname, "..", "..", "..");
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        if (statSync(full).isDirectory()) { if (name !== "simulator" && name !== "node_modules") walk(full); continue; }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
        if (/from\s+["'][^"']*simulator\//.test(readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
    expect(existsSync(join(root, "index.ts"))).toBe(true);
    expect(readFileSync(join(root, "index.ts"), "utf8")).not.toMatch(/knx\/native\/simulator/);
  });
  it("the virtual network has no route to a real address: only registered in-memory endpoints deliver", async () => {
    const clock = new ManualClock(); const n = new VirtualNetwork(clock);
    const sock = await n.createSocketFactory("10.0.0.50")({ onMessage() {}, onError() {} });
    sock.send(Buffer.from("x"), 3671, "192.168.1.10"); // an address that could be a real gateway
    await clock.advance(10);
    expect(n.stats.noRoute).toBe(1);
    expect(n.stats.delivered).toBe(0);
    sock.close();
  });
});
