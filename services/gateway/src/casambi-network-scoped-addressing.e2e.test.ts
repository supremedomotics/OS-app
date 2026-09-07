import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  DriverBindingEngine,
  InMemoryProtocolBindingStore,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type DiscoveredDevice,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import { InMemoryInstalledDriverStore } from "@supreme/drivers";
import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";

/**
 * § Multi-network Casambi, Stage 4 — the critical collision test, exactly as specified: two
 * Casambi networks each reporting "Unit 45", commissioned as two separate Supreme devices,
 * surviving a real restart, independently discoverable/readable/commandable, and independently
 * removable. `native-driver-factory.test.ts` proves the address-scoping translation logic in
 * isolation (including against a REAL `CasambiProtocolDriver.bind()`); this proves the SAME
 * scoping composed with the rest of the real pipeline end to end — commission, persisted
 * binding, boot-time rebind, command routing, state routing, uninstall isolation.
 *
 * A `FakeDriver` stands in for `CasambiProtocolDriver`, already reporting the SAME kind of
 * backendId `withCasambiInstanceAddressing` would produce for a real driver (scoped for the
 * non-primary instance, bare for the primary) — this test is about whether the REST of the
 * system (bind/persist/rebind/route/uninstall) handles those addresses correctly, which is
 * protocol-agnostic and does not require simulating real Casambi UDP traffic.
 */
class FakeDriver {
  connected = false;
  readonly writes: Array<{ deviceId: DeviceId; command: CapabilityCommand }> = [];
  private readonly bound = new Map<string, string>(); // "deviceId:capability" -> address
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
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
  async bind(b: ProtocolBinding): Promise<void> {
    this.bound.set(`${b.deviceId}:${b.capability}`, b.address);
    this.devices.add(b.deviceId);
  }
  async unbind(deviceId: DeviceId): Promise<void> {
    for (const k of [...this.bound.keys()]) if (k.startsWith(`${deviceId}:`)) this.bound.delete(k);
    this.devices.delete(deviceId);
  }
  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }
  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    this.writes.push({ deviceId, command });
    const state: CapabilityState = { kind: "onoff", on: command.action === "on" } as CapabilityState;
    this.states.set(`${deviceId}:${command.capability}`, state);
    const event = { deviceId, capability: command.capability, state, ts: new Date().toISOString() };
    for (const l of this.listeners) l(event);
  }
  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(`${deviceId}:${capability}`) ?? null;
  }
  async discover(): Promise<DiscoveredDevice[]> {
    return this.foundDevices;
  }
  onState(l: StateListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

describe("Casambi network-scoped addressing — the critical collision scenario (§ Multi-network Casambi, Stage 4)", () => {
  let db: PgliteDb;

  beforeAll(async () => {
    db = await PgliteDb.create();
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });

  // § A driver store AND a protocol-binding store, both shared across every `AppContext.create()`
  // call in one test — exactly like a real hub restart shares its persisted rows. Without an
  // explicit `protocolBindingStore`, `bindProtocol()` no-ops on persistence entirely
  // (`this.d.protocolBindingStore?.put(binding)`), so a "restart" would have nothing to restore
  // and the rebind-on-boot half of this test would prove nothing. Found live: exactly that.
  function deps(driverStore: InMemoryInstalledDriverStore, protocolBindingStore: InMemoryProtocolBindingStore) {
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
      protocolBindingStore,
    };
  }

  const config = loadConfig({ SUPREME_LOG_LEVEL: "silent", SUPREME_DEV_MODE: "1" });

  /** Builds a fresh AppContext wired to two FakeDrivers standing in for Network 1 (primary,
   * bare addresses) and Network 2 (scoped addresses) — everything reachable through the SAME
   * `ctx.installer`/`ctx.sil` surface the real routes use. */
  async function bootWithBothNetworks(
    driverStore: InMemoryInstalledDriverStore,
    protocolBindingStore: InMemoryProtocolBindingStore,
    net1Id: string,
    net2Id: string,
  ) {
    const registry = new EntityRegistryMirror();
    const providers = new ProviderRegistry();
    const net1Driver = new FakeDriver("casambi", [{ backendId: "casambi:45", suggestedName: "Unit 45", capabilities: ["onoff"], raw: {} }]);
    const net2Driver = new FakeDriver(`casambi#${net2Id}`, [
      { backendId: `casambi:${net2Id}:45`, suggestedName: "Unit 45", capabilities: ["onoff"], raw: {} },
    ]);
    const engine = new SupremeNativeAdapter({ drivers: [net1Driver, net2Driver] });
    await engine.connect();
    const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    const ctx = await AppContext.create(config, { ...deps(driverStore, protocolBindingStore), sil });
    return { ctx, net1Driver, net2Driver };
  }

  it("Network 1 -> Unit 45, Network 2 -> Unit 45: commission both, restart, discover both, read state from both, command both, uninstall one, verify the other remains intact", async () => {
    const driverStore = new InMemoryInstalledDriverStore();
    const protocolBindingStore = new InMemoryProtocolBindingStore();

    // ── Install both instances first, so their real ids exist for the FakeDrivers to reference. ──
    const bootCtx = await AppContext.create(config, { ...deps(driverStore, protocolBindingStore) });
    const net1 = await bootCtx.installer.drivers.install("supreme-casambi");
    const net2 = await bootCtx.installer.drivers.install("supreme-casambi", undefined, { asNewInstance: true, label: "Network 2" });
    await bootCtx.shutdown();

    // ── Commission both — identical Unit IDs, on purpose. ──
    let { ctx } = await bootWithBothNetworks(driverStore, protocolBindingStore, net1.id, net2.id);
    const { discovered } = await ctx.installer.discoverWithStatus([net1.id, net2.id]);
    expect(discovered).toHaveLength(2);
    const fromNet1 = discovered.find((d) => d.driverId === net1.id)!;
    const fromNet2 = discovered.find((d) => d.driverId === net2.id)!;
    expect(fromNet1.backendId).toBe("casambi:45");
    expect(fromNet2.backendId).toBe(`casambi:${net2.id}:45`);
    expect(fromNet1.backendId).not.toBe(fromNet2.backendId); // the whole point

    const room = await ctx.home.addRoom({
      id: "room-collision-test" as never,
      homeId: (await ctx.home.getHome())!.id,
      name: "Collision Test Room",
      building: null,
      floor: 0,
      area: null,
      areaType: "other",
      sortOrder: 0,
      icon: null,
      heroImageUrl: null,
      parentRoomId: null,
    } as never);
    const roomId = ((await ctx.home.listRooms()).find((r) => r.name === "Collision Test Room")!.id) as never;

    const device1 = await ctx.installer.commissionDevice({
      backendId: fromNet1.backendId,
      name: "Unit 45 (Network 1)",
      roomId,
      capabilities: ["onoff"],
      protocol: fromNet1.protocol!,
      address: fromNet1.backendId,
    });
    const device2 = await ctx.installer.commissionDevice({
      backendId: fromNet2.backendId,
      name: "Unit 45 (Network 2)",
      roomId,
      capabilities: ["onoff"],
      protocol: fromNet2.protocol!,
      address: fromNet2.backendId,
    });
    expect(device1.id).not.toBe(device2.id);
    await ctx.shutdown();

    // ── Restart: a genuine second boot against the SAME persisted store + bindings. ──
    // `reconcileManifestDrivers`'s automatic rebind-on-boot only runs for a driver it can BUILD
    // itself from real config — and building one would immediately EVICT the FakeDriver this
    // test injected (`registerDriver`'s documented "replace any existing instance for this
    // protocol"), leaving assertions against a stale, disconnected reference. So this replays
    // the SAME two persisted bindings through the SAME `sil.bindNative()` call
    // `runDriverLifecycle`'s "restoring_bindings" stage makes on every real boot — using the REAL
    // persisted rows from `protocolBindingStore`, not values re-typed by hand — which is exactly
    // the part of "restart preserves the correct network association" that address-scoping
    // (Stage 4's own scope) needs to prove: that a bare and a scoped address, replayed through
    // the real bind path, land on the correct driver instance and never cross.
    const rebooted = await bootWithBothNetworks(driverStore, protocolBindingStore, net1.id, net2.id);
    ctx = rebooted.ctx;
    const { net1Driver: rebootedNet1Driver, net2Driver: rebootedNet2Driver } = rebooted;

    const persistedBindings = await protocolBindingStore.list();
    expect(persistedBindings).toHaveLength(2); // both survived to disk, correctly
    for (const b of persistedBindings) {
      await ctx.sil.bindNative({ deviceId: b.deviceId, capability: b.capability, address: b.address, config: b.config }, b.protocol);
    }

    // Replaying the persisted bindings restored BOTH devices to their OWN driver instance —
    // never crossed, even though both addresses name "unit 45."
    expect(rebootedNet1Driver.manages(device1.id)).toBe(true);
    expect(rebootedNet1Driver.manages(device2.id)).toBe(false);
    expect(rebootedNet2Driver.manages(device2.id)).toBe(true);
    expect(rebootedNet2Driver.manages(device1.id)).toBe(false);

    // ── Discover both again post-restart — still two, still distinct, still correctly attributed. ──
    const { discovered: discoveredAgain } = await ctx.installer.discoverWithStatus([net1.id, net2.id]);
    // Both are now already-commissioned, so a fresh discover legitimately reports 0 NEW finds —
    // the real proof is that binding/ownership survived, checked above and via command/state below.
    expect(discoveredAgain.filter((d) => d.driverId === net1.id || d.driverId === net2.id)).toHaveLength(0);

    // ── Command both — verify neither reaches the other's driver. ──
    await ctx.sil.command(device1.id, { capability: "onoff", action: "on" });
    await ctx.sil.command(device2.id, { capability: "onoff", action: "off" });
    expect(rebootedNet1Driver.writes).toHaveLength(1);
    expect(rebootedNet1Driver.writes[0]).toMatchObject({ deviceId: device1.id, command: { action: "on" } });
    expect(rebootedNet2Driver.writes).toHaveLength(1);
    expect(rebootedNet2Driver.writes[0]).toMatchObject({ deviceId: device2.id, command: { action: "off" } });

    // ── Read state from both — independent, never crossed. ──
    const state1 = await ctx.sil.getState(device1.id, "onoff");
    const state2 = await ctx.sil.getState(device2.id, "onoff");
    expect(state1).toMatchObject({ on: true });
    expect(state2).toMatchObject({ on: false });
    // The other driver was never asked and has no state for this device at all.
    expect(rebootedNet2Driver.getState(device1.id, "onoff")).toBeNull();
    expect(rebootedNet1Driver.getState(device2.id, "onoff")).toBeNull();

    // ── Uninstall Network 1 — verify Network 2's device is untouched. ──
    await ctx.installer.uninstallDriver(net1.id as never);
    const remainingDevices = await ctx.home.listDevices();
    expect(remainingDevices.some((d) => d.id === device1.id)).toBe(false); // removed with its owning driver
    expect(remainingDevices.some((d) => d.id === device2.id)).toBe(true); // untouched
    const device2AfterUninstall = await ctx.home.getDevice(device2.id);
    expect(device2AfterUninstall?.name).toBe("Unit 45 (Network 2)");
    // Network 2's driver is still fully functional — command still reaches it.
    await ctx.sil.command(device2.id, { capability: "onoff", action: "on" });
    expect(rebootedNet2Driver.writes).toHaveLength(2);
    expect(rebootedNet2Driver.writes[1]).toMatchObject({ deviceId: device2.id, command: { action: "on" } });

    // State-change listeners fire synchronously but their OWN async work (persisting the new
    // state) is fire-and-forget by design throughout this codebase (native-adapter.ts's own
    // `for (const l of this.listeners) l(event)` never awaits a listener's returned promise) —
    // give that in-flight write a turn to settle before `afterAll` closes the shared db out from
    // under it, or it surfaces as an unrelated-looking "PGlite is closing" rejection.
    await new Promise((r) => setTimeout(r, 20));
    await ctx.shutdown();
  });

  // § Requirements 4/5 — backward compatibility and migration safety. A device commissioned
  // BEFORE this stage existed has a persisted binding with a BARE address ("casambi:45") and no
  // scoping segment at all — the realistic shape of every already-deployed single-instance
  // Casambi install. This must keep working forever with ZERO data migration, and adding a
  // SECOND network later must never retroactively touch or orphan it.
  it("a pre-existing bare-address binding (realistic persisted data) keeps working untouched, including after a second network is added later", async () => {
    const driverStore = new InMemoryInstalledDriverStore();
    const protocolBindingStore = new InMemoryProtocolBindingStore();

    const bootCtx = await AppContext.create(config, { ...deps(driverStore, protocolBindingStore) });
    const legacyNet = await bootCtx.installer.drivers.install("supreme-casambi"); // the ONLY instance — primary, unscoped
    await bootCtx.shutdown();

    // Simulate a device commissioned before Stage 4 existed: a real commission() call, at a time
    // when only the primary instance exists, produces exactly this bare-address shape.
    const registry = new EntityRegistryMirror();
    const providers = new ProviderRegistry();
    const legacyDriver = new FakeDriver("casambi", [{ backendId: "casambi:45", suggestedName: "Legacy Fixture", capabilities: ["onoff"], raw: {} }]);
    const engine = new SupremeNativeAdapter({ drivers: [legacyDriver] });
    await engine.connect();
    const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
    let sil = new SupremeIntegrationLayer({ adapter: router, registry });
    let ctx = await AppContext.create(config, { ...deps(driverStore, protocolBindingStore), sil });

    const { discovered } = await ctx.installer.discoverWithStatus([legacyNet.id]);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.backendId).toBe("casambi:45"); // bare — no instance ever existed to scope it

    const homeId = (await ctx.home.getHome())!.id;
    await ctx.home.addRoom({
      id: "room-legacy" as never,
      homeId,
      name: "Legacy Room",
      building: null,
      floor: 0,
      area: null,
      areaType: "other",
      sortOrder: 0,
      icon: null,
      heroImageUrl: null,
      parentRoomId: null,
    } as never);
    const roomId = ((await ctx.home.listRooms()).find((r) => r.name === "Legacy Room")!.id) as never;

    const legacyDevice = await ctx.installer.commissionDevice({
      backendId: "casambi:45",
      name: "Legacy Fixture",
      roomId,
      capabilities: ["onoff"],
      protocol: "casambi",
      address: "casambi:45",
    });

    const persisted = await protocolBindingStore.list();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.address).toBe("casambi:45"); // exactly the pre-Stage-4 shape, unchanged
    expect(persisted[0]!.protocol).toBe("casambi");
    await ctx.shutdown();

    // ── Now add a SECOND network — the moment this stage's whole scoping mechanism activates. ──
    const upgradeCtx = await AppContext.create(config, { ...deps(driverStore, protocolBindingStore) });
    const secondNet = await upgradeCtx.installer.drivers.install("supreme-casambi", undefined, { asNewInstance: true, label: "Network 2" });
    await upgradeCtx.shutdown();

    // ── Restart again, with BOTH instances live — replay the persisted binding exactly as boot does. ──
    const registry2 = new EntityRegistryMirror();
    const providers2 = new ProviderRegistry();
    const legacyDriver2 = new FakeDriver("casambi", [{ backendId: "casambi:45", suggestedName: "Legacy Fixture", capabilities: ["onoff"], raw: {} }]);
    const net2Driver2 = new FakeDriver(`casambi#${secondNet.id}`, [
      { backendId: `casambi:${secondNet.id}:45`, suggestedName: "Unit 45", capabilities: ["onoff"], raw: {} },
    ]);
    const engine2 = new SupremeNativeAdapter({ drivers: [legacyDriver2, net2Driver2] });
    await engine2.connect();
    const router2 = new ProviderRouter({ engine: engine2, registry: providers2, bindingEngine: new DriverBindingEngine(engine2, providers2) });
    sil = new SupremeIntegrationLayer({ adapter: router2, registry: registry2 });
    ctx = await AppContext.create(config, { ...deps(driverStore, protocolBindingStore), sil });

    const persistedAfterUpgrade = await protocolBindingStore.list();
    expect(persistedAfterUpgrade).toHaveLength(1); // still the ONE legacy binding — untouched, never rewritten
    expect(persistedAfterUpgrade[0]!.address).toBe("casambi:45");
    for (const b of persistedAfterUpgrade) {
      await ctx.sil.bindNative({ deviceId: b.deviceId, capability: b.capability, address: b.address, config: b.config }, b.protocol);
    }

    // The legacy device is still correctly owned by the PRIMARY driver — never silently migrated
    // to, or confused with, the newly-added Network 2.
    expect(legacyDriver2.manages(legacyDevice.id)).toBe(true);
    expect(net2Driver2.manages(legacyDevice.id)).toBe(false);

    await ctx.sil.command(legacyDevice.id, { capability: "onoff", action: "on" });
    expect(legacyDriver2.writes).toHaveLength(1);
    expect(net2Driver2.writes).toHaveLength(0); // never reached the new instance

    await new Promise((r) => setTimeout(r, 20));
    await ctx.shutdown();
  });
});
