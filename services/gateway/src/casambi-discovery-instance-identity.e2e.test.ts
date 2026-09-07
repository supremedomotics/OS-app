import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  DriverBindingEngine,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type DiscoveredDevice,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import { InMemoryInstalledDriverStore } from "@supreme/drivers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";

/**
 * § Multi-network Casambi, Stage 3 — proves discovery-time instance identity survives the full
 * chain through `InstallerServices.discoverWithStatus()`: driver instance -> discovery ->
 * discovered device -> (would-be) binding, using the SAME `runtimeProtocolFor`-scoped protocol
 * strings Stage 2a's runtime registration actually produces. `native-adapter.test.ts` already
 * proves the deeper adapter-level bind/command routing; this proves the GATEWAY-LEVEL wiring
 * that attaches `driverId`/`instanceLabel` onto what a client actually receives, including the
 * deterministic legacy-instance fallback label (§ requirement 5) end-to-end, not just in the
 * pure `driver-manager.ts` unit tests.
 *
 * Uses `supreme-knx` as a stand-in driver (exactly the existing `driver-realtime-state.e2e.test`
 * pattern: inject a FakeDriver directly into the adapter, install the manifest driver WITHOUT
 * a complete config so `reconcileManifestDrivers` never tries to build and register a REAL one
 * over it) so this test needs no real UDP socket or Casambi network. The generic "Instance"
 * noun this produces is fine — the Casambi-specific "Network"/"Gateway" noun is already proven
 * in `driver-manager.test.ts`'s `casambiInstanceNoun` tests; this file is about the WIRING.
 */
class FakeDriver {
  connected = false;
  private readonly listeners = new Set<StateListener>();
  constructor(
    readonly protocol: string,
    private readonly foundDevices: DiscoveredDevice[],
  ) {}
  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async bind(_b: ProtocolBinding): Promise<void> {}
  manages(_id: DeviceId): boolean {
    return false;
  }
  async command(_id: DeviceId, _c: CapabilityCommand): Promise<void> {}
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null {
    return null;
  }
  async discover(): Promise<DiscoveredDevice[]> {
    return this.foundDevices;
  }
  onState(l: StateListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

describe("Discovery attaches correct instance identity (§ Multi-network Casambi, Stage 3)", () => {
  let db: PgliteDb;

  beforeAll(async () => {
    db = await PgliteDb.create();
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });

  // § A driver store shared across every `AppContext.create()` call in one test, exactly like a
  // real hub restart shares its persisted rows — `deps()` deliberately never set `driverStore`
  // itself before this, so passing NONE meant DriverManager silently defaulted to its OWN fresh
  // in-memory store per call (`store: opts.store ?? new InMemoryInstalledDriverStore()`), making
  // two `AppContext.create()` calls invisible to each other's installed drivers even though they
  // share the same Postgres `db` for everything else. Found live: this test's first draft
  // discovered zero devices from either instance because of exactly this.
  function deps(driverStore: InMemoryInstalledDriverStore) {
    const s = buildStores(db);
    return {
      identityStore: s.identity,
      homeStore: s.home,
      sceneStore: s.scenes,
      grantStore: s.grants,
      notificationStore: s.notifications,
      db,
      pendingDeviceStore: s.pendingDevices,
      driverStore,
    };
  }

  // Both instances report the IDENTICAL unit id — the real Casambi scenario (unit 45 exists
  // independently on two networks; addressing has no network scoping yet, which is Stage 4's
  // job, not this one's).
  const UNIT_ID = "knx.unit45";

  async function ctxWithTwoInstances() {
    const registry = new EntityRegistryMirror();
    const providers = new ProviderRegistry();
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent", SUPREME_DEV_MODE: "1" });
    const driverStore = new InMemoryInstalledDriverStore();
    const ctx = await AppContext.create(config, { ...deps(driverStore) });
    // Two "supreme-knx" instances, deliberately left config-INCOMPLETE (no `host`) so
    // `reconcileManifestDrivers` never builds a real driver and replaces the injected FakeDriver
    // below — matches `driver-realtime-state.e2e.test.ts`'s own established pattern.
    const primary = await ctx.installer.drivers.install("supreme-knx"); // legacy: predates any label
    const secondary = await ctx.installer.drivers.install("supreme-knx", undefined, { asNewInstance: true, label: "Gateway 2" });

    const primaryDriver = new FakeDriver("knx", [{ backendId: UNIT_ID, suggestedName: "Unit 45", capabilities: ["onoff"], raw: {} }]);
    const secondaryProtocol = `knx#${secondary.id}`; // the exact string `runtimeProtocolFor` would compute
    const secondaryDriver = new FakeDriver(secondaryProtocol, [{ backendId: UNIT_ID, suggestedName: "Unit 45", capabilities: ["onoff"], raw: {} }]);
    const engine = new SupremeNativeAdapter({ drivers: [primaryDriver, secondaryDriver] });
    await engine.connect();
    const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
    // Replace the context's SIL with one wired to our two-driver adapter — same technique
    // `driver-realtime-state.e2e.test.ts` uses, just after install() so the driver ids exist first.
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    const ctx2 = await AppContext.create(config, { ...deps(driverStore), sil });
    return { ctx: ctx2, primary, secondary };
  }

  it("two instances discovering the IDENTICAL unit id both appear, each correctly attributed", async () => {
    const { ctx, primary, secondary } = await ctxWithTwoInstances();
    const { discovered } = await ctx.installer.discoverWithStatus([primary.id, secondary.id]);
    expect(discovered).toHaveLength(2);
    const fromPrimary = discovered.find((d) => d.driverId === primary.id)!;
    const fromSecondary = discovered.find((d) => d.driverId === secondary.id)!;
    expect(fromPrimary).toBeTruthy();
    expect(fromSecondary).toBeTruthy();
    expect(fromPrimary.backendId).toBe(UNIT_ID);
    expect(fromSecondary.backendId).toBe(UNIT_ID); // identical unit id, by design

    // Instance labels: the legacy primary (installed with no label, before any sibling existed)
    // gets the deterministic fallback the moment a sibling appears — never blank, never confused
    // with the secondary's own explicit label.
    expect(fromPrimary.instanceLabel).toBe("Instance 1");
    expect(fromSecondary.instanceLabel).toBe("Gateway 2");
    expect(fromPrimary.instanceLabel).not.toBe(fromSecondary.instanceLabel);
  });

  it("a single-instance driver's discovered device has NO instance label — unchanged presentation", async () => {
    const registry = new EntityRegistryMirror();
    const providers = new ProviderRegistry();
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent", SUPREME_DEV_MODE: "1" });
    const driverStore = new InMemoryInstalledDriverStore();
    const ctx = await AppContext.create(config, { ...deps(driverStore) });
    const only = await ctx.installer.drivers.install("supreme-knx");

    const driver = new FakeDriver("knx", [{ backendId: "knx.solo", suggestedName: "Solo Unit", capabilities: ["onoff"], raw: {} }]);
    const engine = new SupremeNativeAdapter({ drivers: [driver] });
    await engine.connect();
    const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    const ctx2 = await AppContext.create(config, { ...deps(driverStore), sil });

    const { discovered } = await ctx2.installer.discoverWithStatus([only.id]);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.instanceLabel).toBeNull();
    expect(discovered[0]!.driverId).toBe(only.id);
  });
});
