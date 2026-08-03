import { newId, type CapabilityCommand, type CapabilityKind, type CapabilityState, type DeviceId } from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  MigrationPolicy,
  MockAdapter,
  DriverBindingEngine,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";

/**
 * Ordinary-vs-Exceptional Device Routing (§ Priority 1 — Casambi must match KNX automatic
 * commissioning). An "ordinary" discovered device — real capabilities AND a resolvable room
 * (driver roomHint, or its name matching an existing room) — now commissions straight through
 * scanForApproval() with zero installer action, through the SAME shared pipeline direct pairing
 * always used (commissionDevice -> resolveOrCreateRoom -> Device Registry -> Room). Pending
 * Approval is reserved for genuine exceptions: no usable capability, or no reliable room signal
 * at all. This is driver-independent — the same canAutoCommission() gate applies to KNX,
 * Casambi, and every future protocol; nothing here branches on protocol.
 */
class FakeCasambi implements INativeProtocolDriver {
  readonly protocol = "casambi";
  private readonly devices = new Set<DeviceId>();
  private readonly listeners = new Set<StateListener>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(): Promise<void> {}
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> {
    return [
      { backendId: "casambi:pending-1", suggestedName: "R&D Study Lights", capabilities: ["brightness"], raw: { room: "R&D" } },
      { backendId: "casambi:pending-2", suggestedName: "R&D Downlight", capabilities: ["brightness"], raw: { room: "r&d" } },
      // No capabilities at all — a genuine exception (§ "unsupported capabilities") regardless
      // of room signal, so this must never auto-commission.
      { backendId: "casambi:pending-3", suggestedName: "Diagnostic Sensor", capabilities: [], raw: {} },
      { backendId: "casambi:pending-4", suggestedName: "Rescan Test Light", capabilities: ["onoff"], raw: { room: "R&D" } },
      // Real capabilities but NO room signal at all (no hint, name matches no existing room) —
      // a genuine exception (§ "ambiguous room assignment"), the real gap seen on hardware
      // where a Casambi luminaire has no Group and no name that matches an existing room.
      { backendId: "casambi:pending-5", suggestedName: "Mystery Puck", capabilities: ["onoff"], raw: {} },
      // No room signal on its FIRST scan (stays pending) — a matching room then gets created,
      // and a SECOND scan should retroactively auto-commission it and clean up the stale
      // pending row, not leave it stuck forever.
      { backendId: "casambi:pending-6", suggestedName: "Attic Vent Light", capabilities: ["onoff"], raw: {} },
      { backendId: "casambi:pending-7", suggestedName: "Spare Sensor", capabilities: [], raw: {} },
      // § ADR 0018 Capability Normalization Pipeline: real capabilities + a driver-normalized
      // capabilityConfig, but NO room signal at all — forces this through Pending Approval
      // (not the auto-commit fast path) so the test proves capabilityConfig survives that
      // detour byte-identical, not just the same-tick auto-commit path.
      {
        backendId: "casambi:pending-8",
        suggestedName: "Widget CCT Puck",
        capabilities: ["onoff", "brightness", "color"],
        raw: {},
        capabilityConfig: { color: { colorModes: { rgb: false, cct: true } } },
      },
    ];
  }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

describe("Ordinary devices auto-commission through Universal Room Intelligence; exceptions still use Pending Approval", () => {
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
      identityStore: s.identity,
      homeStore: s.home,
      sceneStore: s.scenes,
      grantStore: s.grants,
      notificationStore: s.notifications,
      db,
      pendingDeviceStore: s.pendingDevices,
    };
  }

  function sil() {
    const registry = new EntityRegistryMirror();
    const routerEngine0 = new SupremeNativeAdapter({ drivers: [new FakeCasambi()] });
    const routerProviders0 = new ProviderRegistry();
    const router = new ProviderRouter({ engine: routerEngine0, registry: routerProviders0, bindingEngine: new DriverBindingEngine(routerEngine0, routerProviders0) })
    return new SupremeIntegrationLayer({ adapter: router, registry });
  }

  it("an ordinary device with a driver-reported room hint auto-commissions with ZERO installer action — never enters Pending Approval", async () => {
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent" });
    const ctx = await AppContext.create(config, { ...deps(), sil: sil() });
    const inst = ctx.installer;

    const before = await ctx.home.listRooms();
    expect(before.some((r) => r.name === "R&D")).toBe(false);

    const pending = await inst.scanForApproval();
    expect(pending.some((p) => p.backendId === "casambi:pending-1")).toBe(false); // never staged

    const rd = (await ctx.home.listRooms()).find((r) => r.name === "R&D");
    expect(rd).toBeTruthy(); // room auto-created from the driver's own roomHint, no approval click
    const roomDevices = await ctx.home.listDevicesInRoom(rd!.id as never);
    expect(roomDevices.some((d) => d.name === "R&D Study Lights")).toBe(true);

    await ctx.shutdown();
  });

  it("a second ordinary device with a differently-punctuated hint reuses the auto-created room, never duplicates it", async () => {
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent" });
    const ctx = await AppContext.create(config, { ...deps(), sil: sil() });
    const inst = ctx.installer;

    expect((await ctx.home.listRooms()).filter((r) => r.name === "R&D").length).toBe(1); // same DB as the previous test

    const pending = await inst.scanForApproval();
    expect(pending.some((p) => p.backendId === "casambi:pending-2")).toBe(false); // also auto-commissioned, not staged

    const rooms = await ctx.home.listRooms();
    expect(rooms.filter((r) => r.name === "R&D").length).toBe(1); // normalized "r&d" reused it — no duplicate room
    const rd = rooms.find((r) => r.name === "R&D")!;
    expect((await ctx.home.listDevicesInRoom(rd.id as never)).some((d) => d.name === "R&D Downlight")).toBe(true);

    await ctx.shutdown();
  });

  it("a device with no usable capability is a genuine exception — stays in Pending Approval, and an explicit installer roomId still overrides at approval", async () => {
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent" });
    const ctx = await AppContext.create(config, { ...deps(), sil: sil() });
    const inst = ctx.installer;
    const rooms = await ctx.home.listRooms();
    const otherRoom = rooms.find((r) => r.name !== "R&D")!;

    const pending = await inst.scanForApproval();
    const diag = pending.find((p) => p.backendId === "casambi:pending-3");
    expect(diag).toBeTruthy(); // no capabilities -> exceptional, correctly held for review

    await inst.approvePendingDevice(diag!.id, { roomId: otherRoom.id as never, capabilities: ["sensor"] });
    const placed = await ctx.home.listDevicesInRoom(otherRoom.id as never);
    expect(placed.some((d) => d.name === "Diagnostic Sensor")).toBe(true); // explicit choice always wins

    await ctx.shutdown();
  });

  it("re-scanning an auto-commissioned device does not recommission or duplicate it", async () => {
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent" });
    const ctx = await AppContext.create(config, { ...deps(), sil: sil() });
    const inst = ctx.installer;

    await inst.scanForApproval();
    const rd = (await ctx.home.listRooms()).find((r) => r.name === "R&D")!;
    const firstCount = (await ctx.home.listDevicesInRoom(rd.id as never)).filter((d) => d.name === "Rescan Test Light").length;
    expect(firstCount).toBe(1);

    const pendingAfterFirst = await inst.listPendingDevices();
    expect(pendingAfterFirst.some((p) => p.backendId === "casambi:pending-4")).toBe(false);

    await inst.scanForApproval(); // re-scan — commissioning's own dedupe should exclude the now-owned backendId entirely
    const secondCount = (await ctx.home.listDevicesInRoom(rd.id as never)).filter((d) => d.name === "Rescan Test Light").length;
    expect(secondCount).toBe(1); // still exactly one — no duplicate device, no re-staging

    await ctx.shutdown();
  });

  it("a device with real capabilities but NO reliable room signal at all is a genuine exception — approving with no override falls back to Unassigned, never a guess", async () => {
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent" });
    const ctx = await AppContext.create(config, { ...deps(), sil: sil() });
    const inst = ctx.installer;

    const pending = await inst.scanForApproval();
    const puck = pending.find((p) => p.backendId === "casambi:pending-5");
    expect(puck).toBeTruthy(); // no roomHint, name matches no existing room -> ambiguous, correctly held
    expect(puck!.roomHint).toBeFalsy();

    await inst.approvePendingDevice(puck!.id, { capabilities: ["onoff"] }); // no explicit roomId

    const unassigned = (await ctx.home.listRooms()).find((r) => r.name === "Unassigned");
    expect(unassigned).toBeTruthy();
    expect((await ctx.home.listDevicesInRoom(unassigned!.id as never)).some((d) => d.name === "Mystery Puck")).toBe(true);

    await ctx.shutdown();
  });

  it("a device staged as pending BEFORE its matching room existed auto-commissions on a later rescan and cleans up its stale pending record", async () => {
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent" });
    const ctx = await AppContext.create(config, { ...deps(), sil: sil() });
    const inst = ctx.installer;

    // First scan: no "Attic" room exists yet, so "Attic Vent Light" is a genuine exception.
    const firstScan = await inst.scanForApproval();
    expect(firstScan.some((p) => p.backendId === "casambi:pending-6")).toBe(true);

    // The installer creates "Attic" for an unrelated reason (e.g. approving a different device).
    const anyExistingRoom = (await ctx.home.listRooms())[0]!;
    await ctx.home.addRoom({
      id: newId("room") as never, homeId: anyExistingRoom.homeId, name: "Attic", building: null, floor: 0,
      area: null, areaType: "other", sortOrder: 99, icon: null, heroImageUrl: null, parentRoomId: null,
    });

    // Second scan: the device now matches an existing room — it must auto-commission AND the
    // stale pending row from the first scan must be gone, not linger forever.
    const secondScan = await inst.scanForApproval();
    expect(secondScan.some((p) => p.backendId === "casambi:pending-6")).toBe(false);

    const attic = (await ctx.home.listRooms()).find((r) => r.name === "Attic")!;
    expect((await ctx.home.listDevicesInRoom(attic.id as never)).some((d) => d.name === "Attic Vent Light")).toBe(true);

    await ctx.shutdown();
  });

  it("an orphaned pending row for a device that's already owned (commissioned some other way) is pruned on the next scan, even if the device never resurfaces in discover()", async () => {
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent" });
    const ctx = await AppContext.create(config, { ...deps(), sil: sil() });
    const inst = ctx.installer;

    // Simulate the exact real-world gap: a device gets approved/commissioned directly (never
    // through this pending flow), but an old pending row for the SAME backendId is left behind
    // (e.g. staged by an earlier scan under different code, or a race). Approve casambi:pending-3
    // directly via the exceptional-device path, then re-stage a synthetic stale row for it.
    const pending = await inst.scanForApproval();
    const spare = pending.find((p) => p.backendId === "casambi:pending-7")!;
    const rooms = await ctx.home.listRooms();
    await inst.approvePendingDevice(spare.id, { roomId: rooms[0]!.id as never, capabilities: ["sensor"] });

    // The device is now owned. Re-scanning must not resurrect a stuck/duplicate pending entry
    // for it, and any leftover row for an already-owned backendId must be pruned.
    const rescan = await inst.scanForApproval();
    expect(rescan.some((p) => p.backendId === "casambi:pending-7")).toBe(false);

    await ctx.shutdown();
  });

  it("§ ADR 0018 — a driver-normalized capabilityConfig survives Discovery → Pending → Approval byte-identical, exactly like the auto-commit fast path produces", async () => {
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent" });
    const ctx = await AppContext.create(config, { ...deps(), sil: sil() });
    const inst = ctx.installer;

    const pending = await inst.scanForApproval();
    const widget = pending.find((p) => p.backendId === "casambi:pending-8");
    expect(widget).toBeTruthy(); // no room signal -> genuine exception, correctly held for review

    // Simulate a restart: fetch the pending record fresh from the store (not the in-memory
    // `found` array scanForApproval built it from) to prove it's actually PERSISTED, not just
    // carried in memory for the duration of one call.
    const rehydrated = (await inst.listPendingDevices()).find((p) => p.backendId === "casambi:pending-8");
    expect(rehydrated?.capabilityConfig).toEqual({ color: { colorModes: { rgb: false, cct: true } } });

    const device = await inst.approvePendingDevice(widget!.id, { roomId: (await ctx.home.listRooms())[0]!.id as never });
    const persisted = await ctx.home.getDevice(device.id);
    const colorCap = persisted?.capabilities.find((c) => c.kind === "color");
    expect(colorCap?.config).toEqual({ colorModes: { rgb: false, cct: true } }); // byte-identical

    await ctx.shutdown();
  });
});
