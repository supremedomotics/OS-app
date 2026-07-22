import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  MigrationPolicy,
  MockAdapter,
  RoutingBackendAdapter,
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
 * Installed Driver Selection for Discovery (§ Priority 4, Part 2). Proves the selector is a
 * REAL backend execution filter (installer-context.discoverWithStatus -> commissioning ->
 * SIL -> native-adapter), not a frontend-only result filter — plus failure isolation and
 * user-facing driver-name labeling, via the real installed-driver registry (DriverManager +
 * seeded first-party catalog), not a second/fake registry.
 */
class FakeDriver implements INativeProtocolDriver {
  private readonly devices = new Set<DeviceId>();
  private readonly listeners = new Set<StateListener>();
  constructor(
    readonly protocol: string,
    private readonly result: DiscoveredDevice[] | (() => Promise<DiscoveredDevice[]>),
  ) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(): Promise<void> {}
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> {
    return typeof this.result === "function" ? this.result() : this.result;
  }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

const knxDevices: DiscoveredDevice[] = [
  { backendId: "knx:1", suggestedName: "Kitchen Ceiling Light", capabilities: ["onoff"], raw: {} },
];
const casambiDevices: DiscoveredDevice[] = [
  { backendId: "casambi:1", suggestedName: "R&D Downlight", capabilities: ["brightness"], raw: {} },
];

describe("Discovery Driver Selector actually gates which drivers execute", () => {
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

  /** A fresh AppContext with KNX + Casambi installed and a CoolMaster driver that always fails. */
  async function ctxWithInstalledDrivers(coolmasterFails: boolean) {
    const registry = new EntityRegistryMirror();
    const router = new RoutingBackendAdapter({
      ha: new MockAdapter(),
      native: new SupremeNativeAdapter({
        drivers: [
          new FakeDriver("knx", knxDevices),
          new FakeDriver("casambi", casambiDevices),
          new FakeDriver("coolmaster", async () => {
            if (coolmasterFails) throw new Error("Connection timeout");
            return [{ backendId: "coolmaster:1", suggestedName: "Conference AC", capabilities: ["onoff"], raw: {} }];
          }),
        ],
      }),
      registry,
      policy: new MigrationPolicy(),
    });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent", SUPREME_DEV_MODE: "1" });
    const ctx = await AppContext.create(config, { ...deps(), sil });
    const inst = ctx.installer;

    // Real installed-driver registry (same source Extension Center reads) — install the
    // first-party KNX + Casambi bundles from the seeded dev catalog; leave CoolMaster
    // uninstalled to prove it's excluded as "not an installed driver", not just deselected.
    const knx = await inst.drivers.install("supreme-knx");
    const casambi = await inst.drivers.install("supreme-casambi");
    return { ctx, inst, knxInstalledId: knx.id, casambiInstalledId: casambi.id };
  }

  it("discoverableDrivers() exposes only installed drivers, sourced from the real DriverManager registry", async () => {
    const { ctx, inst } = await ctxWithInstalledDrivers(false);
    const drivers = await inst.discoverableDrivers();
    const keys = drivers.map((d) => d.key);
    expect(keys).toContain("supreme-knx");
    expect(keys).toContain("supreme-casambi");
    expect(keys).not.toContain("coolmaster"); // never installed -> cannot be selected/executed
    await ctx.shutdown();
  });

  it("selecting one driver executes only that driver — the deselected driver never runs", async () => {
    const { ctx, inst, knxInstalledId } = await ctxWithInstalledDrivers(false);
    const { discovered, driverResults } = await inst.discoverWithStatus([knxInstalledId]);
    expect(discovered.some((d) => d.backendId === "knx:1")).toBe(true);
    expect(discovered.some((d) => d.backendId.startsWith("casambi:"))).toBe(false);
    expect(driverResults.map((r) => r.protocol)).toEqual(["knx"]); // casambi never even attempted
    await ctx.shutdown();
  });

  it("Select All (all installed driver IDs) executes every installed discoverable driver", async () => {
    const { ctx, inst, knxInstalledId, casambiInstalledId } = await ctxWithInstalledDrivers(false);
    const { discovered } = await inst.discoverWithStatus([knxInstalledId, casambiInstalledId]);
    expect(discovered.some((d) => d.backendId === "knx:1")).toBe(true);
    expect(discovered.some((d) => d.backendId === "casambi:1")).toBe(true);
    await ctx.shutdown();
  });

  it("Deselect All (empty driverIds array) runs no discovery at all", async () => {
    const { ctx, inst } = await ctxWithInstalledDrivers(false);
    const { discovered, driverResults } = await inst.discoverWithStatus([]);
    expect(discovered).toEqual([]);
    expect(driverResults).toEqual([]); // not "scan everything" — [] means nothing selected
    await ctx.shutdown();
  });

  it("one driver failing does not discard the other drivers' successful results", async () => {
    const { ctx, inst, knxInstalledId, casambiInstalledId } = await ctxWithInstalledDrivers(true);
    const coolmaster = await inst.drivers.install("supreme-coolmaster").catch(() => null);
    const ids = [knxInstalledId, casambiInstalledId, coolmaster?.id].filter(Boolean) as string[];

    const { discovered, driverResults } = await inst.discoverWithStatus(ids);
    expect(discovered.some((d) => d.backendId === "knx:1")).toBe(true);
    expect(discovered.some((d) => d.backendId === "casambi:1")).toBe(true); // survive despite CoolMaster failing

    const failed = driverResults.find((r) => r.protocol === "coolmaster");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("Connection timeout");
    const knxResult = driverResults.find((r) => r.protocol === "knx");
    expect(knxResult?.status).toBe("complete");
    await ctx.shutdown();
  });

  it("discovered devices expose the installed driver's user-facing name, never an internal protocol id", async () => {
    const { ctx, inst, knxInstalledId } = await ctxWithInstalledDrivers(false);
    const { discovered } = await inst.discoverWithStatus([knxInstalledId]);
    const kitchen = discovered.find((d) => d.backendId === "knx:1");
    expect(kitchen?.driverName).toBe("Supreme KNX"); // manifest display name, not "knx"
    await ctx.shutdown();
  });
});
