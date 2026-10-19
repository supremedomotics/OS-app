import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterEach, describe, expect, it } from "vitest";
import { KnxProtocolDriver, type KnxConnection } from "../../knx-driver.js";
import { createWorld, GA, type World } from "./simulator/test-world.js";
import { createSingleSlotConnectionFactory } from "./single-slot.js";

/**
 * Driver-facing link state (`KnxProtocolDriver.connectionState()` / `isConnected()`), STAGE: simulator-tested only. The native cases tunnel into the
 * virtual gateway; the legacy cases use a plain fake with no `linkState` and pin that nothing changed for connections that do not report one.
 */
const DEV = "device-knx-light" as DeviceId;
let w: World | null = null;
afterEach(async () => {
  if (!w) return;
  for (const c of w.connections) { const p = c.disconnect(); await w.clock.advance(100); await p.catch(() => undefined); }
  await w.clock.advance(300_000);
  w.iface.shutdown();
  expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 });
  w = null;
});

class PlainFake implements KnxConnection {
  connects = 0; disconnects = 0; observed = 0; unobserved = 0;
  gate: Promise<void> | null = null;
  failNext = false;
  async connect(): Promise<void> { this.connects++; if (this.gate) await this.gate; if (this.failNext) { this.failNext = false; throw new Error("No more connections"); } }
  async disconnect(): Promise<void> { this.disconnects++; }
  async write(): Promise<void> {}
  observe(): () => void { this.observed++; return () => { this.unobserved++; }; }
}

describe("legacy / plain connections (no linkState): behaviour unchanged", () => {
  it("connected after connect(), disconnected after disconnect(), 'connecting' while the first attempt is in flight", async () => {
    const fake = new PlainFake();
    let release!: () => void;
    fake.gate = new Promise<void>((r) => { release = r; });
    const d = new KnxProtocolDriver({ host: "h", createConnection: async () => fake });
    expect(d.connectionState()).toBe("disconnected");
    const p = d.connect();
    await Promise.resolve();
    expect(d.connectionState()).toBe("connecting");
    expect(d.isConnected()).toBe(false);
    release(); await p;
    expect(d.connectionState()).toBe("connected");
    expect(d.isConnected()).toBe(true);
    await d.disconnect();
    expect(d.connectionState()).toBe("disconnected");
  });

  it("a failed first connect stays retryable (no connection kept, next connect() builds a new one)", async () => {
    const fakes: PlainFake[] = [];
    const d = new KnxProtocolDriver({ host: "h", createConnection: async () => { const f = new PlainFake(); if (fakes.length === 0) f.failNext = true; fakes.push(f); return f; } });
    await expect(d.connect()).rejects.toThrow("No more connections");
    expect(d.isConnected()).toBe(false);
    expect(d.connectionState()).toBe("disconnected");
    await d.connect();
    expect(fakes).toHaveLength(2);
    expect(d.isConnected()).toBe(true);
  });

  it("disconnect() during an in-flight connect cancels it: the caller is rejected at once, the connection is closed and never kept (previously it went live after the disconnect)", async () => {
    const fake = new PlainFake();
    let release!: () => void;
    fake.gate = new Promise<void>((r) => { release = r; });
    const d = new KnxProtocolDriver({ host: "h", createConnection: async () => fake });
    const p = d.connect().then(() => "connected", (e: Error) => e.message);
    await Promise.resolve(); await Promise.resolve();
    await d.disconnect();
    expect(await p).toBe("knx: disconnected during connect"); // rejected BEFORE the connection's own connect() settled
    expect(fake.disconnects).toBe(1);
    release();                                              // a connection that ignores the cancellation and resolves later changes nothing
    await Promise.resolve(); await Promise.resolve();
    expect(d.isConnected()).toBe(false);
    expect(d.connectionState()).toBe("disconnected");
  });

  it("a connection whose connect() NEVER settles after being disconnected (the legacy wrapper waits for an event) cannot wedge the driver: the caller is released and a later connect() works", async () => {
    const hung = new PlainFake();
    hung.gate = new Promise<void>(() => undefined);          // never settles, even after disconnect()
    const good = new PlainFake();
    const made: PlainFake[] = [hung, good];
    const d = new KnxProtocolDriver({ host: "h", createConnection: async () => made.shift()! });
    const p = d.connect().then(() => "connected", (e: Error) => e.message);
    await Promise.resolve(); await Promise.resolve();
    await d.disconnect();
    expect(await p).toBe("knx: disconnected during connect");
    expect(d.connectionState()).toBe("disconnected");
    await d.connect();                                       // `connecting` was cleared: not stuck on the abandoned attempt
    expect(d.isConnected()).toBe(true);
    expect(good.connects).toBe(1);
  });

  it("disconnect() while the connection FACTORY is still working: the connection it returns is closed, never kept", async () => {
    const fake = new PlainFake();
    let release!: () => void;
    const slowFactory = new Promise<void>((r) => { release = r; });
    const d = new KnxProtocolDriver({ host: "h", createConnection: async () => { await slowFactory; return fake; } });
    const p = d.connect().then(() => "connected", (e: Error) => e.message);
    await d.disconnect();
    release();
    expect(await p).toBe("knx: disconnected during connect");
    expect(fake.connects).toBe(0);                         // not even attempted
    expect(fake.disconnects).toBe(1);
    expect(d.isConnected()).toBe(false);
  });

  it("a later connect() after a cancelled one works (the epoch only cancels connects that started before the disconnect)", async () => {
    const fake = new PlainFake();
    let release!: () => void;
    fake.gate = new Promise<void>((r) => { release = r; });
    const d = new KnxProtocolDriver({ host: "h", createConnection: async () => fake });
    const first = d.connect().catch(() => undefined);
    await Promise.resolve(); await Promise.resolve();
    await d.disconnect();
    fake.gate = null;
    release(); await first;
    await d.connect();
    expect(d.isConnected()).toBe(true);
  });
});

describe("native connection: the driver reports the real link, not the existence of a connection object", () => {
  const events = (d: KnxProtocolDriver): BackendStateEvent[] => { const e: BackendStateEvent[] = []; d.onState((x) => e.push(x)); return e; };
  const setup = async () => {
    w = createWorld();
    w.actuator("1.1.10", "1/0/1", "1/0/2");
    const d = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: async () => w!.connection() });
    await d.bind({ deviceId: DEV, capability: "onoff", address: "1/0/1", config: { statusAddress: "1/0/2", dpt: "DPT1.001" } });
    const p = d.connect();
    expect(d.connectionState()).toBe("connecting");
    await w.until(p, 2_000);
    return d;
  };
  const report = async (value: boolean): Promise<void> => { w!.sender.emit(w!.bus, GA("1/0/2"), "1.001", value); await w!.clock.advance(5); };

  it("connecting → connected → recovering → connected; isConnected() is false while recovering", async () => {
    const d = await setup();
    expect(d.connectionState()).toBe("connected");
    expect(d.isConnected()).toBe(true);
    w!.iface.reboot(30_000);
    await w!.clock.advance(28_000);
    expect(d.connectionState()).toBe("recovering");
    expect(d.isConnected()).toBe(false);
    await expect(d.command(DEV, { capability: "onoff", action: "set", on: true })).rejects.toMatchObject({ code: "not_connected" });
    await w!.clock.advance(60_000);
    expect(d.connectionState()).toBe("connected");
    expect(d.isConnected()).toBe(true);
  });

  it("recovery creates no second tunnel, no extra bus subscription and no duplicate state delivery (3 outages)", async () => {
    const d = await setup();
    const ev = events(d);
    const conn = w!.connections[0]!;
    const subs = conn.diagnostics().bus.activeSubscriptions;
    expect(subs).toBe(1);
    await report(true);
    expect(ev.filter((e) => e.provenance !== "commanded")).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      w!.iface.reboot(30_000);
      await w!.clock.advance(28_000);
      expect(d.connectionState()).toBe("recovering");
      // while recovering, a call to connect() (the gateway's 60 s reconcile) must not start a competing tunnel
      await d.connect();
      expect(w!.connections).toHaveLength(1);
      await w!.clock.advance(60_000);
      expect(d.connectionState()).toBe("connected");
    }
    expect(w!.connections).toHaveLength(1);
    expect(conn.diagnostics().bus.activeSubscriptions).toBe(subs);
    expect(conn.diagnostics().link.attachedTunnels).toBe(1);
    expect(w!.iface.activeChannels).toBe(1);
    const before = ev.filter((e) => e.provenance !== "commanded").length;
    await report(false);
    expect(ev.filter((e) => e.provenance !== "commanded")).toHaveLength(before + 1); // exactly one delivery per telegram after recovery
  });

  it("a failed initial connection (gateway refuses) leaves nothing running and the same driver can simply retry", async () => {
    w = createWorld({ interface: { maxTunnels: 1 } });
    w.iface.faults.refuseConnectStatus = 0x24;
    const d = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: async () => w!.connection() });
    const first = d.connect().then(() => "connected", (e: { code?: string }) => e.code);
    await w.until(first, 2_000);
    expect(await first).toBe("connect_rejected");
    expect(d.connectionState()).toBe("disconnected");
    expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 });
    w.iface.faults.refuseConnectStatus = null;
    await w.until(d.connect(), 2_000);
    expect(d.connectionState()).toBe("connected");
    expect(w.connections).toHaveLength(2);
  });

  it("a connection replaced behind the driver's back (single-slot factory) reads as disconnected, and the driver's own retry builds a fresh one", async () => {
    w = createWorld({ interface: { maxTunnels: 1 } });
    const factory = createSingleSlotConnectionFactory(() => w!.connection());
    const a = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: factory });
    await w.until(a.connect(), 2_000);
    expect(a.isConnected()).toBe(true);
    const b = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: factory });
    await w.until(b.connect(), 3_000);                     // closes a's connection first
    expect(a.isConnected()).toBe(false);                   // not "healthy because the object exists"
    expect(a.connectionState()).toBe("disconnected");
    expect(b.isConnected()).toBe(true);
    await w.until(a.disconnect(), 2_000);
    await w.until(b.disconnect(), 2_000);
    await w.clock.advance(1_000);
    expect(w.iface.activeChannels).toBe(0);
  });

  it("disconnect() during the native connect handshake: caller rejected promptly, the half-open tunnel is closed orderly, the driver stays disconnected", async () => {
    w = createWorld({ interface: { maxTunnels: 1 } });
    w.net.addRule({ match: (p) => p.service === 0x0206, action: "delay", delayMs: 1_500, times: 1 });
    const d = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: async () => w!.connection() });
    const p = d.connect().then(() => "connected", (e: Error) => e.message);
    await w.clock.advance(50);
    expect(w.iface.activeChannels).toBe(1);
    await d.disconnect();
    expect(await w.until(p, 100)).toBe("knx: disconnected during connect");
    await w.clock.advance(3_000);
    expect(d.isConnected()).toBe(false);
    expect(w.iface.activeChannels).toBe(0);
  });
});

