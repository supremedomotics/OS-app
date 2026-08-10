import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  DriverBindingEngine,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext, type DriverStateEvent } from "./context.js";

/**
 * § Realtime State Architecture — proves the backend HALF of the KNX Connect/Disconnect
 * fix: connectDriver()/disconnectDriver() must publish real driverState events (via the
 * same event bus device-state/notifications already use) rather than leaving the UI to
 * guess from a one-shot health fetch. This is deliberately driver-agnostic — the fixture
 * uses a generic FakeDriver, not KNX-specific code, to prove the fix lives in the shared
 * connect/disconnect pipeline every current and future native driver goes through.
 */
class FakeDriver {
  connected = false;
  private readonly listeners = new Set<StateListener>();
  constructor(readonly protocol: string, private readonly failConnect = false) {}
  async connect(): Promise<void> {
    if (this.failConnect) throw new Error("simulated connect failure");
    this.connected = true;
  }
  async disconnect(): Promise<void> { this.connected = false; }
  isConnected(): boolean { return this.connected; }
  async bind(_b: ProtocolBinding): Promise<void> {}
  manages(_id: DeviceId): boolean { return false; }
  async command(_id: DeviceId, _c: CapabilityCommand): Promise<void> {}
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover() { return []; }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

describe("Driver connect/disconnect publish real driverState events", () => {
  let db: PgliteDb;

  beforeAll(async () => {
    db = await PgliteDb.create();
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });

  function deps() {
    const s = buildStores(db);
    return {
      identityStore: s.identity, homeStore: s.home, sceneStore: s.scenes,
      grantStore: s.grants, notificationStore: s.notifications, db,
      pendingDeviceStore: s.pendingDevices,
    };
  }

  async function ctxWithInstalledKnx(failConnect = false) {
    const registry = new EntityRegistryMirror();
    const driver = new FakeDriver("knx", failConnect);
    const engine = new SupremeNativeAdapter({ drivers: [driver] });
    const providers = new ProviderRegistry();
    const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent", SUPREME_DEV_MODE: "1" });
    const ctx = await AppContext.create(config, { ...deps(), sil });
    const knx = await ctx.installer.drivers.install("supreme-knx");
    return { ctx, installedId: knx.id, driver };
  }

  it("connectDriver() publishes 'connecting' then 'connected', in order, before resolving", async () => {
    const { ctx, installedId } = await ctxWithInstalledKnx();
    const events: DriverStateEvent[] = [];
    const unsub = ctx.onDriverState((e) => events.push(e));

    const result = await ctx.installer.connectDriver(installedId);

    expect(result.connected).toBe(true);
    expect(events.map((e) => e.state)).toEqual(["connecting", "connected"]);
    expect(events.every((e) => e.driverId === installedId)).toBe(true);
    unsub();
    await ctx.shutdown();
  });

  it("connectDriver() publishes 'connecting' then 'error' when the native driver fails to connect — never silently 'connected'", async () => {
    const { ctx, installedId } = await ctxWithInstalledKnx(true);
    const events: DriverStateEvent[] = [];
    const unsub = ctx.onDriverState((e) => events.push(e));

    await ctx.installer.connectDriver(installedId).catch(() => {});

    expect(events.map((e) => e.state)).toEqual(["connecting", "error"]);
    unsub();
    await ctx.shutdown();
  });

  it("disconnectDriver() publishes 'disconnecting' then 'disconnected', in order", async () => {
    const { ctx, installedId } = await ctxWithInstalledKnx();
    await ctx.installer.connectDriver(installedId);
    const events: DriverStateEvent[] = [];
    const unsub = ctx.onDriverState((e) => events.push(e));

    const result = await ctx.installer.disconnectDriver(installedId);

    expect(result.disconnected).toBe(true);
    expect(events.map((e) => e.state)).toEqual(["disconnecting", "disconnected"]);
    unsub();
    await ctx.shutdown();
  });

  it("multiple subscribers (simulating multiple open UI tabs/components) all observe the same events — no per-subscriber divergence", async () => {
    const { ctx, installedId } = await ctxWithInstalledKnx();
    const eventsA: DriverStateEvent[] = [];
    const eventsB: DriverStateEvent[] = [];
    const unsubA = ctx.onDriverState((e) => eventsA.push(e));
    const unsubB = ctx.onDriverState((e) => eventsB.push(e));

    await ctx.installer.connectDriver(installedId);

    expect(eventsA.map((e) => e.state)).toEqual(["connecting", "connected"]);
    expect(eventsB.map((e) => e.state)).toEqual(["connecting", "connected"]);
    unsubA();
    unsubB();
    await ctx.shutdown();
  });

  it("unsubscribing stops delivery (no leaked listener continuing to fire)", async () => {
    const { ctx, installedId } = await ctxWithInstalledKnx();
    const events: DriverStateEvent[] = [];
    const unsub = ctx.onDriverState((e) => events.push(e));
    unsub();

    await ctx.installer.connectDriver(installedId);

    expect(events).toEqual([]);
    await ctx.shutdown();
  });

  // § Realtime State Hardening — autonomous lifecycle: connection loss/recovery that
  // NOTHING user-initiated caused (no Connect/Disconnect click). reconcileDriverConnectivity()
  // is the runner hook main.ts's existing 60s tick calls; these tests call it directly
  // rather than waiting on a real timer.
  describe("reconcileDriverConnectivity() — autonomous connection loss/recovery", () => {
    it("publishes 'error' when an already-connected driver drops on its own — no user action, no setStage() stage change", async () => {
      const { ctx, installedId, driver } = await ctxWithInstalledKnx();
      await ctx.installer.connectDriver(installedId);
      driver.connected = false; // autonomous drop — NOT via disconnectDriver()
      const events: DriverStateEvent[] = [];
      const unsub = ctx.onDriverState((e) => events.push(e));

      await ctx.installer.reconcileDriverConnectivity();

      expect(events.map((e) => e.state)).toEqual(["error"]);
      expect(events[0]!.driverId).toBe(installedId);
      unsub();
      await ctx.shutdown();
    });

    it("publishes 'connected' when a dropped driver recovers on its own", async () => {
      const { ctx, installedId, driver } = await ctxWithInstalledKnx();
      await ctx.installer.connectDriver(installedId);
      driver.connected = false;
      await ctx.installer.reconcileDriverConnectivity(); // observes the drop first
      driver.connected = true; // autonomous recovery
      const events: DriverStateEvent[] = [];
      const unsub = ctx.onDriverState((e) => events.push(e));

      await ctx.installer.reconcileDriverConnectivity();

      expect(events.map((e) => e.state)).toEqual(["connected"]);
      unsub();
      await ctx.shutdown();
    });

    it("publishes nothing when connectivity hasn't actually changed (no false-positive churn every tick)", async () => {
      const { ctx, installedId } = await ctxWithInstalledKnx();
      await ctx.installer.connectDriver(installedId);
      const events: DriverStateEvent[] = [];
      const unsub = ctx.onDriverState((e) => events.push(e));

      await ctx.installer.reconcileDriverConnectivity();
      await ctx.installer.reconcileDriverConnectivity();
      await ctx.installer.reconcileDriverConnectivity();

      expect(events).toEqual([]);
      unsub();
      await ctx.shutdown();
    });

    it("does not touch a driver that was never confirmed 'ready' (mid-installation churn is setStage()'s job, not this reconciliation's)", async () => {
      const { ctx } = await ctxWithInstalledKnx();
      const events: DriverStateEvent[] = [];
      const unsub = ctx.onDriverState((e) => events.push(e));

      await ctx.installer.reconcileDriverConnectivity(); // driver never connected — nothing to reconcile

      expect(events).toEqual([]);
      unsub();
      await ctx.shutdown();
    });
  });

  // § Realtime State Hardening — the low-level publish point de-duplicates identical
  // back-to-back events regardless of which code path produced them.
  it("does not publish a duplicate event when two independent code paths observe the same transition", async () => {
    const { ctx, installedId } = await ctxWithInstalledKnx();
    // First connect reaches "ready" via connectDriver()'s own explicit publish.
    await ctx.installer.connectDriver(installedId);
    const events: DriverStateEvent[] = [];
    const unsub = ctx.onDriverState((e) => events.push(e));

    // Reconciliation runs immediately after — connectivity hasn't changed, so even
    // though it re-observes "connected", it must not re-publish it.
    await ctx.installer.reconcileDriverConnectivity();

    expect(events).toEqual([]);
    unsub();
    await ctx.shutdown();
  });
});
