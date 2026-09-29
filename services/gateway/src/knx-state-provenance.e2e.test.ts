import type { CapabilityState, DeviceId } from "@supreme/domain-model";
import {
  DriverBindingEngine,
  EntityRegistryMirror,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type ProtocolBinding,
} from "@supreme/integration-layer";
import { KnxProtocolDriver, type KnxConnection } from "@supreme/protocols";
import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";

/**
 * Physical-driver validation gate — state provenance regression (finding G1 and its fix).
 *
 * The REAL `KnxProtocolDriver` sits behind the REAL SIL and `AppContext` state feed; only the
 * KNXnet/IP socket is a stand-in (`KnxConnection`) whose actuator we control: it can stay silent,
 * or put a status telegram on the bus, or another writer can put a value on the COMMAND address.
 *
 * NOT physical-driver validation: no hardware is involved. This proves what the Hub PUBLISHES as
 * the device's state, and when, for each thing that can happen on the bus.
 */
class Bus implements KnxConnection {
  writes: { ga: string; value: unknown }[] = [];
  private observers = new Map<string, (v: unknown) => void>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async write(ga: string, value: unknown): Promise<void> {
    this.writes.push({ ga, value }); // accepted; nothing answers unless a test says so
  }
  observe(ga: string, _dpt: string, handler: (v: never) => void): () => void {
    this.observers.set(ga, handler as (v: unknown) => void);
    return () => this.observers.delete(ga);
  }
  /** A telegram appearing on the bus at [ga] — whoever sent it. */
  telegram(ga: string, v: unknown): void {
    this.observers.get(ga)?.(v);
  }
  listens(ga: string): boolean {
    return this.observers.has(ga);
  }
}

interface Published {
  state: CapabilityState;
  provenance: string;
}

describe("KNX state provenance (real driver → SIL → Hub state feed)", () => {
  let db: PgliteDb;
  beforeAll(async () => {
    db = await PgliteDb.create();
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });

  async function rig() {
    const bus = new Bus();
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
    let n = 0;
    async function bind(capability: string, address: string, config: ProtocolBinding["config"]): Promise<DeviceId> {
      const deviceId = `dev_knx_${capability}_${++n}` as DeviceId;
      await engine.bind({ deviceId, capability: capability as never, address, config }, "knx");
      await providers.assign(deviceId, "knx");
      await providers.transition(deviceId, "BINDING");
      await providers.transition(deviceId, "BOUND");
      return deviceId;
    }
    await driver.connect();
    const published: Published[] = [];
    // Exactly what a WebSocket client is fed from (`stream.ts` reads `event.provenance`).
    ctx.onState((e) => published.push({ state: e.state, provenance: e.provenance ?? "observed" }));
    const settle = () => new Promise((r) => setTimeout(r, 80)); // bus fan-out is async
    return { bus, driver, ctx, sil, bind, published, settle };
  }

  it("silent actuator: the command is announced as COMMANDED, the Hub holds no state, and nothing observed ever appears", async () => {
    const { bus, ctx, sil, bind, published, settle } = await rig();
    const id = await bind("onoff", "1/1/1", { statusAddress: "1/1/2" });
    await sil.command(id, { capability: "onoff", action: "on" });
    await settle();

    expect(bus.writes).toEqual([{ ga: "1/1/1", value: true }]);
    expect(published.map((p) => p.provenance)).toEqual(["commanded"]);
    expect(published.some((p) => p.provenance === "observed")).toBe(false);
    // The Hub's own answer to "what state is this device in?" is: nothing has been reported.
    expect(await sil.getState(id, "onoff")).toBeNull();
    await ctx.shutdown();
  });

  it("a real status telegram on the declared status address is OBSERVED, and becomes the device's state", async () => {
    const { bus, ctx, sil, bind, published, settle } = await rig();
    const id = await bind("onoff", "1/1/1", { statusAddress: "1/1/2" });
    await sil.command(id, { capability: "onoff", action: "on" });
    bus.telegram("1/1/2", true); // the actuator's own status object
    await settle();

    expect(published.map((p) => p.provenance)).toEqual(["commanded", "observed"]);
    expect(published[1]!.state).toEqual({ kind: "onoff", on: true });
    expect(await sil.getState(id, "onoff")).toEqual({ kind: "onoff", on: true });

    // And when the actuator disagrees, the report is what it is.
    bus.telegram("1/1/2", false);
    await settle();
    expect(await sil.getState(id, "onoff")).toEqual({ kind: "onoff", on: false });
    await ctx.shutdown();
  });

  it("a telegram on the COMMAND address alone (another writer) is never the device's state", async () => {
    const { bus, ctx, sil, bind, published, settle } = await rig();
    const id = await bind("onoff", "1/1/1", { statusAddress: "1/1/2" });
    expect(bus.listens("1/1/1")).toBe(false); // the command address is not observed at all
    bus.telegram("1/1/1", true);
    await settle();
    expect(published).toEqual([]);
    expect(await sil.getState(id, "onoff")).toBeNull();
    await ctx.shutdown();
  });

  it("no status address: nothing is observed and no state is fabricated — even when the command address carries a value", async () => {
    const { bus, driver, ctx, sil, bind, published, settle } = await rig();
    const id = await bind("onoff", "1/1/1", {});
    expect(bus.listens("1/1/1")).toBe(false);
    await sil.command(id, { capability: "onoff", action: "on" });
    bus.telegram("1/1/1", true); // some other writer, or our own echo: not attributable
    await settle();

    expect(published.map((p) => p.provenance)).toEqual(["commanded"]);
    expect(await sil.getState(id, "onoff")).toBeNull();
    // The device declares, structurally, that it has no feedback — so clients use the separate
    // "sent, unverified" lifecycle rather than waiting for a report that cannot come.
    expect(driver.getCapabilityConfig(id, "onoff")).toEqual({ feedback: "none" });
    await ctx.shutdown();
  });

  it("an installer may EXPLICITLY declare that the command address is also the status object", async () => {
    const { bus, ctx, sil, bind, published, settle } = await rig();
    const id = await bind("onoff", "1/1/1", { statusAddress: "1/1/1", feedbackOnCommandAddress: true });
    expect(bus.listens("1/1/1")).toBe(true);
    bus.telegram("1/1/1", true);
    await settle();
    expect(published.map((p) => p.provenance)).toEqual(["observed"]);
    expect(await sil.getState(id, "onoff")).toEqual({ kind: "onoff", on: true });
    await ctx.shutdown();
  });

  it("the same address for command and status WITHOUT that declaration is ambiguous, so it is not feedback", async () => {
    const { bus, ctx, bind, settle, published } = await rig();
    await bind("onoff", "1/1/1", { statusAddress: "1/1/1" });
    expect(bus.listens("1/1/1")).toBe(false);
    bus.telegram("1/1/1", true);
    await settle();
    expect(published).toEqual([]);
    await ctx.shutdown();
  });

  it("shade: a position report says WHERE, not whether it is moving — moving is unknown (null), never false", async () => {
    const { bus, ctx, sil, bind, published, settle } = await rig();
    const id = await bind("position", "2/1/1", { statusAddress: "2/1/2", dpt: "DPT5.001" });
    await sil.command(id, { capability: "position", action: "set", position: 60 });
    bus.telegram("2/1/2", 35); // an intermediate position report
    await settle();

    const observed = published.find((p) => p.provenance === "observed")!;
    expect(observed.state).toEqual({ kind: "position", position: 35, moving: null });
    expect((observed.state as { moving: unknown }).moving).not.toBe(false);
    expect(published.find((p) => p.provenance === "commanded")!.state).toMatchObject({ position: 60, moving: null });
    await ctx.shutdown();
  });
});
