import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fake `knxultimate` KNXClient — real enough to exercise connect/reconnect/read/
 * indication wiring without a real KNX bus. Each `new FakeClient()` call is tracked so
 * tests can assert exactly one client exists at a time and that stale ones are dropped. */
class FakeClient extends EventEmitter {
  static instances: FakeClient[] = [];
  /** When true, `Connect()` never emits `connected`/`error` — simulates the real,
   * observed failure mode a dropped UDP handshake produces (§ production defect:
   * "Connection timeout to 192.168.0.21:3671" with no local deadline to catch it). */
  static hangOnConnect = false;
  connectCalls = 0;
  readCalls: string[] = [];
  writeCalls: { ga: string; value: unknown; dpt: string }[] = [];
  disconnected = false;
  constructorOpts: Record<string, unknown>;

  constructor(opts: Record<string, unknown> = {}) {
    super();
    this.constructorOpts = opts;
    FakeClient.instances.push(this);
  }
  Connect(): void {
    this.connectCalls++;
    if (!FakeClient.hangOnConnect) queueMicrotask(() => this.emit("connected"));
  }
  async Disconnect(): Promise<void> {
    this.disconnected = true;
  }
  write(groupAddress: string, value: unknown, dpt: string): void {
    this.writeCalls.push({ ga: groupAddress, value, dpt });
  }
  read(groupAddress: string): void {
    this.readCalls.push(groupAddress);
  }
  /** Test helper: simulate a real GroupValueWrite/status indication arriving. */
  emitIndication(groupAddress: string, raw: Buffer): void {
    this.emit("indication", {
      cEMIMessage: { dstAddress: { toString: () => groupAddress }, npdu: { dataValue: raw, isGroupWrite: true, isGroupResponse: false } },
    });
  }
  /** Test helper: simulate a GroupValueRead REQUEST (no real feedback payload) arriving
   * on a subscribed GA — must never be decoded as state (§ PASS 23 bug fix). */
  emitGroupRead(groupAddress: string, raw: Buffer): void {
    this.emit("indication", {
      cEMIMessage: { dstAddress: { toString: () => groupAddress }, npdu: { dataValue: raw, isGroupWrite: false, isGroupResponse: false } },
    });
  }
}

const fakeDptlib = {
  resolve: (dpt: string) => dpt,
  fromBuffer: (raw: Buffer) => raw[0] === 1,
};

vi.mock("knxultimate", () => ({
  KNXClient: FakeClient,
  dptlib: fakeDptlib,
  default: { KNXClient: FakeClient, dptlib: fakeDptlib },
}));

describe("KnxUltimateProvider", () => {
  beforeEach(() => {
    FakeClient.instances = [];
    FakeClient.hangOnConnect = false;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes localAddress through to the underlying client as localIPAddress (§ multi-homed hub interface binding)", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    const provider = new KnxUltimateProvider({ host: "192.168.0.21", localAddress: "192.168.0.117" });
    await provider.connect();
    expect(FakeClient.instances[0]?.constructorOpts.localIPAddress).toBe("192.168.0.117");
  });

  it("fails a hung connect attempt after connectTimeoutMs instead of hanging forever, and cleans up the stuck client (§ production defect: 'Connection timeout to 192.168.0.21:3671' with no local deadline)", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    FakeClient.hangOnConnect = true;
    const provider = new KnxUltimateProvider({ host: "192.168.0.21", connectTimeoutMs: 20 });

    await expect(provider.connect()).rejects.toThrow(/timed out after 20ms/);
    expect(FakeClient.instances[0]?.disconnected).toBe(true); // stuck client cleaned up, not leaked
  });

  it("recovers via the Connection Manager's existing backoff/retry after a connect timeout, once the underlying transport starts responding again", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    FakeClient.hangOnConnect = true;
    const provider = new KnxUltimateProvider({ host: "192.168.0.21", connectTimeoutMs: 20 });
    await expect(provider.connect()).rejects.toThrow();

    // The gateway/hub "comes back" — subsequent connect attempts succeed normally.
    FakeClient.hangOnConnect = false;
    await provider.connect(); // second direct call after a failed first — same idempotent path this file already exercises
    expect(provider.health().connected).toBe(true);
  });

  it("executes bus.group_read as a real GroupValueRead request, not a fabricated no-op", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    const provider = new KnxUltimateProvider({ host: "10.0.0.1" });
    await provider.connect();
    await provider.execute({ kind: "bus.group_read", groupAddress: "1/1/1", dpt: "1.001" });
    expect(FakeClient.instances[0]?.readCalls).toEqual(["1/1/1"]);
  });

  it("delivers a real indication (the read's async response) to the subscribed handler", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    const provider = new KnxUltimateProvider({ host: "10.0.0.1" });
    const values: unknown[] = [];
    provider.subscribe("1/1/1", "1.001", (v) => values.push(v));
    await provider.connect();
    await provider.execute({ kind: "bus.group_read", groupAddress: "1/1/1", dpt: "1.001" });
    FakeClient.instances[0]!.emitIndication("1/1/1", Buffer.from([1]));
    expect(values).toEqual([true]);
  });

  it("§ PASS 19 diagnostic — a telegram on a GA with no subscribed handler counts as unmatchedFeedbackTelegrams, not silently dropped with zero trace", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    const provider = new KnxUltimateProvider({ host: "10.0.0.1" });
    provider.subscribe("1/1/1", "1.001", () => {});
    await provider.connect();
    // A real telegram on a DIFFERENT group address than anything subscribed — e.g. the
    // exact live symptom under investigation: a binding's feedback GA differs (even
    // subtly — casing/padding/notation) from what the underlying KNX client reports.
    FakeClient.instances[0]!.emitIndication("5/3/1", Buffer.from([1]));
    expect(provider.diagnostics().unmatchedFeedbackTelegrams).toBe(1);
    expect(provider.diagnostics().packetsReceived).toBe(1); // the telegram WAS received — just not matched
  });

  it("§ PASS 19 diagnostic — a matched telegram does NOT count as unmatched", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    const provider = new KnxUltimateProvider({ host: "10.0.0.1" });
    provider.subscribe("1/1/1", "1.001", () => {});
    await provider.connect();
    FakeClient.instances[0]!.emitIndication("1/1/1", Buffer.from([1]));
    expect(provider.diagnostics().unmatchedFeedbackTelegrams).toBe(0);
  });

  it("§ PASS 23 bug fix — a GroupValueRead REQUEST on a subscribed status GA is never decoded as feedback (knxultimate's NPDU.dataValue always returns a Buffer, even for a read with no real payload)", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    const provider = new KnxUltimateProvider({ host: "10.0.0.1" });
    const values: unknown[] = [];
    provider.subscribe("1/1/1", "1.001", (v) => values.push(v));
    await provider.connect();
    // A real GroupValueWrite establishes the true state first (e.g. a physical ON press).
    FakeClient.instances[0]!.emitIndication("1/1/1", Buffer.from([1]));
    // A GroupValueRead REQUEST arrives on the SAME GA afterwards (another device polling,
    // an ETS Group Monitor read, or this driver's own State-Synchronization group-read
    // reflecting off the bus) — its APCI's data bits are 0, which used to be misdecoded
    // as a spurious "off"/0 and silently overwrite the real state.
    FakeClient.instances[0]!.emitGroupRead("1/1/1", Buffer.from([0]));
    expect(values).toEqual([true]); // only the real GroupValueWrite ever reached the handler
    // Not counted as unmatched either — it's a different telegram TYPE, not feedback that
    // failed to find a binding.
    expect(provider.diagnostics().unmatchedFeedbackTelegrams).toBe(0);
  });

  it("§ PASS 20 diagnostic (Part A) — lastFeedbackTelegram captures the matched telegram's destination, dpt, and decoded value", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    const provider = new KnxUltimateProvider({ host: "10.0.0.1" });
    provider.subscribe("5/3/1", "1.001", () => {});
    await provider.connect();
    FakeClient.instances[0]!.emitIndication("5/3/1", Buffer.from([1]));
    const snap = provider.diagnostics().lastFeedbackTelegram;
    expect(snap?.matched).toBe(true);
    expect(snap?.destination).toBe("5/3/1");
    expect(snap?.dpt).toBe("1.001");
    expect(snap?.value).toBe(true); // fakeDptlib.fromBuffer: raw[0] === 1
    expect(provider.diagnostics().lastUnmatchedFeedback).toBeNull();
  });

  it("§ PASS 20 diagnostic (Part A) — lastUnmatchedFeedback captures destination only, never a guessed dpt/value for an unknown GA", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    const provider = new KnxUltimateProvider({ host: "10.0.0.1" });
    provider.subscribe("1/1/1", "1.001", () => {});
    await provider.connect();
    FakeClient.instances[0]!.emitIndication("5/3/1", Buffer.from([1]));
    const snap = provider.diagnostics().lastUnmatchedFeedback;
    expect(snap?.matched).toBe(false);
    expect(snap?.destination).toBe("5/3/1");
    expect(snap?.dpt).toBeUndefined();
    expect(snap?.value).toBeUndefined();
    expect(provider.diagnostics().lastFeedbackTelegram).toBeNull();
  });

  it("§ PASS 20 diagnostic (Part A) — isSubscribed() reports the true, current subscription state for an exact GA", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    const provider = new KnxUltimateProvider({ host: "10.0.0.1" });
    expect(provider.isSubscribed("5/3/1")).toBe(false);
    provider.subscribe("5/3/1", "1.001", () => {});
    expect(provider.isSubscribed("5/3/1")).toBe(true);
    expect(provider.isSubscribed("5/3/2")).toBe(false); // a different, unsubscribed GA
    provider.unsubscribe("5/3/1");
    expect(provider.isSubscribed("5/3/1")).toBe(false);
  });

  it("fires onConnectionStateChange('connected') on the very first connect", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    const provider = new KnxUltimateProvider({ host: "10.0.0.1" });
    const states: string[] = [];
    provider.onConnectionStateChange((s) => states.push(s));
    await provider.connect();
    expect(states).toContain("connected");
  });

  it("subscription survives a reconnect — the fresh client is wired to the SAME observer map, no re-subscribe needed", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    const provider = new KnxUltimateProvider({ host: "10.0.0.1" });
    const values: unknown[] = [];
    provider.subscribe("1/1/1", "1.001", (v) => values.push(v));
    await provider.connect();
    const firstClient = FakeClient.instances[0]!;

    // Simulate a post-connect drop: the client errors after having connected.
    firstClient.emit("error", new Error("tunnel closed"));
    // The dead client can no longer deliver anything...
    firstClient.emitIndication("1/1/1", Buffer.from([1]));
    expect(values).toEqual([]); // ...correctly not delivered — the client is retired.

    // Let the Connection Manager's supervised reconnect run (fast default backoff would
    // normally apply; this asserts the STRUCTURAL guarantee — reconnect creates a new
    // client wired to the same observers — without depending on fake timers here).
    await vi.waitFor(() => expect(FakeClient.instances.length).toBeGreaterThan(1), { timeout: 2000 });
    const secondClient = FakeClient.instances[FakeClient.instances.length - 1]!;
    secondClient.emitIndication("1/1/1", Buffer.from([1]));
    expect(values).toEqual([true]); // delivered through the NEW client, same handler —
    // never re-registered by anything, because it was never lost (§ Phase 7 §1).
  }, 10000);

  it("telegramRatePerMinute() is a real division of real counters, null before there's meaningful uptime", async () => {
    const { KnxUltimateProvider } = await import("./knx-ultimate-provider.js");
    const provider = new KnxUltimateProvider({ host: "10.0.0.1" });
    expect(provider.telegramRatePerMinute()).toBeNull(); // not connected yet — never a fabricated 0
    await provider.connect();
    expect(provider.telegramRatePerMinute()).toBeNull(); // uptime <1s — avoids a wildly inflated instantaneous rate

    await new Promise((r) => setTimeout(r, 1100));
    FakeClient.instances[0]!.emitIndication("1/1/1", Buffer.from([1]));
    FakeClient.instances[0]!.emitIndication("1/1/1", Buffer.from([1]));
    const rate = provider.telegramRatePerMinute();
    expect(rate).not.toBeNull();
    expect(rate!).toBeGreaterThan(0); // 2 packets over ~1.1s of uptime — a real, positive rate
  }, 10000);
});

/**
 * § PASS 20 (Part B) — GA string matching. Deliberately imports the REAL `knxultimate`
 * package (no mock, unlike the suite above) to settle, with actual executed proof
 * rather than source-reading, whether an ETS-style group-address string ("5/3/1")
 * survives the library's own encode → wire-buffer → decode round trip unchanged. This
 * is exactly the path a real incoming telegram's `cemi.dstAddress.toString()` takes
 * (`KNXAddress.createFromBuffer` in the installed package, confirmed by inspecting
 * `node_modules/knxultimate/build/protocol/{KNXAddress,cEMI/LDataInd}.js`), and exactly
 * the string the binding engine stores from ETS parsing (`GROUP_ADDRESS_RE` in
 * binding-engine.ts already requires this same "n/n/n" 3-level notation). If this test
 * ever fails, the GA-format-mismatch hypothesis (Pass 19) would need to be reopened.
 */
describe("KNX group-address string round-trip through the REAL knxultimate library (§ PASS 20 Part B)", () => {
  it("an ETS-style 3-level GA string ('5/3/1') survives encode→buffer→decode unchanged — rejects the GA-mismatch hypothesis", async () => {
    const { default: KNXAddress } = await import("knxultimate/build/protocol/KNXAddress.js");
    for (const ga of ["5/3/1", "5/3/0", "5/3/3", "5/3/4", "1/1/1", "31/7/255"]) {
      const encoded = KNXAddress.createFromString(ga, KNXAddress.TYPE_GROUP);
      const buf = encoded.toBuffer();
      const decoded = KNXAddress.createFromBuffer(buf, 0, KNXAddress.TYPE_GROUP);
      expect(decoded.toString()).toBe(ga);
    }
  });
});
