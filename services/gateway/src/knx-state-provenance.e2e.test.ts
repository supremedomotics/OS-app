import type { CapabilityState, DeviceId } from "@supreme/domain-model";
import {
  DriverBindingEngine,
  EntityRegistryMirror,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
} from "@supreme/integration-layer";
import { KnxProtocolDriver, type KnxConnection } from "@supreme/protocols";
import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";

/**
 * Physical-driver validation gate — KNX, finding G1.
 *
 * The REAL `KnxProtocolDriver` sits behind the REAL SIL and `AppContext`; only the KNXnet/IP
 * socket is a stand-in (`KnxConnection`), and its actuator is SILENT: it accepts every group write
 * and never sends feedback (an unpowered actuator, a disconnected line, a dead bus segment).
 *
 * The question: does the Hub's state feed — the one every WebSocket client and the Residence State
 * read — say the device changed when nothing on the bus said so?
 */
class SilentActuatorBus implements KnxConnection {
  writes: { ga: string; value: unknown; dpt: string }[] = [];
  private observers = new Map<string, (v: unknown) => void>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async write(ga: string, value: unknown, dpt: string): Promise<void> {
    this.writes.push({ ga, value, dpt }); // accepted by the interface; nothing ever answers
  }
  observe(ga: string, _dpt: string, handler: (v: never) => void): () => void {
    this.observers.set(ga, handler as (v: unknown) => void);
    return () => this.observers.delete(ga);
  }
  /** What a real actuator would put on the bus. */
  feedback(ga: string, v: unknown): void {
    this.observers.get(ga)?.(v);
  }
}

describe("KNX (real driver, silent actuator): state the Hub publishes vs what the bus reported", () => {
  let db: PgliteDb;
  beforeAll(async () => {
    db = await PgliteDb.create();
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("G1 — the driver publishes an OPTIMISTIC state on command, before (and without) any bus feedback", async () => {
    const bus = new SilentActuatorBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.1", createConnection: async () => bus });
    const s = buildStores(db);
    const registry = new EntityRegistryMirror();
    const engine = new SupremeNativeAdapter({ drivers: [driver] });
    const providers = new ProviderRegistry();
    const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    const ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent", SUPREME_DEV_MODE: "1" }), {
      identityStore: s.identity, homeStore: s.home, sceneStore: s.scenes, grantStore: s.grants,
      notificationStore: s.notifications, db, pendingDeviceStore: s.pendingDevices, sil,
    });

    const deviceId = "dev_knx_switch" as DeviceId;
    await engine.bind({ deviceId, capability: "onoff", address: "1/1/1", config: { statusAddress: "1/1/2" } }, "knx");
    await driver.connect();
    // Commissioned the way the installer flow leaves a bound device: assigned to its provider and BOUND.
    await providers.assign(deviceId, "knx");
    await providers.transition(deviceId, "BINDING");
    await providers.transition(deviceId, "BOUND");

    // Exactly what a WebSocket client is fed from.
    const published: { state: CapabilityState; ts: string }[] = [];
    ctx.onState((e) => {
      if (e.deviceId === deviceId) published.push({ state: e.state, ts: e.ts });
    });

    await sil.command(deviceId, { capability: "onoff", action: "on" });
    await new Promise((r) => setTimeout(r, 100)); // bus fan-out is async

    // The write reached the bus...
    expect(bus.writes).toEqual([{ ga: "1/1/1", value: true, dpt: "DPT1.001" }]);
    // ...and NO telegram came back on the status GA. Yet the Hub has already published "on":
    expect(published.map((p) => (p.state as { on?: boolean }).on)).toEqual([true]);
    // Nothing in the published event distinguishes it from a real device report.
    expect(Object.keys(published[0]!).sort()).toEqual(["state", "ts"]);
    expect(Object.keys(published[0]!.state).sort()).toEqual(["kind", "on"]);

    // Real feedback then disagrees (the actuator did not switch): the Hub corrects itself, but only
    // after having told every client — and CommandTracker, which confirms on any state satisfying
    // the target — that the switch was on.
    bus.feedback("1/1/2", false);
    await new Promise((r) => setTimeout(r, 100));
    expect(published.map((p) => (p.state as { on?: boolean }).on)).toEqual([true, false]);
    await ctx.shutdown();
  });
});
