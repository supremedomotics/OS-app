import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fake `knxultimate` KNXClient — real enough to exercise connect/reconnect/read/
 * indication wiring without a real KNX bus. Each `new FakeClient()` call is tracked so
 * tests can assert exactly one client exists at a time and that stale ones are dropped. */
class FakeClient extends EventEmitter {
  static instances: FakeClient[] = [];
  connectCalls = 0;
  readCalls: string[] = [];
  writeCalls: { ga: string; value: unknown; dpt: string }[] = [];
  disconnected = false;

  constructor() {
    super();
    FakeClient.instances.push(this);
  }
  Connect(): void {
    this.connectCalls++;
    queueMicrotask(() => this.emit("connected"));
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
  /** Test helper: simulate a real GroupValueResponse/status indication arriving. */
  emitIndication(groupAddress: string, raw: Buffer): void {
    this.emit("indication", { cEMIMessage: { dstAddress: { toString: () => groupAddress }, npdu: { dataValue: raw } } });
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
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
});
