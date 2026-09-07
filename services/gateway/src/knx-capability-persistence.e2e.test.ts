import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  InMemoryProtocolBindingStore,
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
import {
  colorModesFromDpt,
  SupremeKnxDriver,
  type IKnxProvider,
  type KnxProviderDiagnostics,
  type KnxProviderHealth,
  type KnxTask,
} from "@supreme/protocols";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { InMemoryHomeStore } from "@supreme/home";

/** § Test isolation (mirrors knx-installer-workflow.e2e.test.ts's own fix, same reason)
 * — the discovery-time driver `installer-context.ts`'s `knxDiscoveryDriver()` builds is
 * a REAL `SupremeKnxDriver`. Left with its default `KnxIotProvider`, it performs REAL
 * CoAP multicast discovery on whatever network this suite runs on — harmless noise on a
 * dev machine with nothing to answer, but on any host actually reachable by real KNX-IoT
 * devices (e.g. a KNX installer's LAN, or a hub machine with local KNX-IoT services
 * running) it silently adds extra, non-deterministic queue items. `discover()`
 * deterministically returns none, so every device in this suite's queue comes only from
 * the ETS fixture under test. */
class FakeEmptyKnxIotProvider implements IKnxProvider {
  readonly name = "fake-empty-knx-iot";
  async initialize(): Promise<void> {}
  async discover(): Promise<never[]> { return []; }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async execute(_task: KnxTask): Promise<unknown> { throw new Error("not applicable — discover() never returns a device to run a task against"); }
  subscribe(): void { throw new Error("not applicable"); }
  unsubscribe(): void {}
  health(): KnxProviderHealth { return { connected: true, lastError: null }; }
  diagnostics(): KnxProviderDiagnostics {
    return { provider: this.name, connected: true, packetsSent: 0, packetsReceived: 0, lastTelegramAt: null, lastCommandAt: null, lastError: null, reconnectAttempts: 0 };
  }
}

/**
 * § P0-C follow-up (Pass 28.1) — capability persistence lifecycle.
 *
 * A fake "knx" protocol driver whose `getCapabilityConfig` reuses the SAME
 * `colorModesFromDpt` evidence function `SupremeKnxDriver` and `planBindings` already
 * use (§ single authoritative capability model — never a fourth, independently-guessed
 * one for this test). Tracks the real DPT it was last bound with per device, so
 * re-binding with a different DPT (simulating a re-import that found new ETS evidence
 * for the SAME physical fixture) genuinely changes what this driver reports — exactly
 * mirroring how a real re-scan against updated ETS group addresses would behave.
 */
class FakeKnxCapabilityDriver implements INativeProtocolDriver {
  readonly protocol = "knx";
  private readonly devices = new Set<DeviceId>();
  private readonly colorDpt = new Map<DeviceId, string>();
  private readonly listeners = new Set<StateListener>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> {
    this.devices.add(b.deviceId);
    if (b.capability === "color" && typeof b.config?.dpt === "string") this.colorDpt.set(b.deviceId, b.config.dpt);
  }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(_id: DeviceId, _c: CapabilityCommand): Promise<void> {}
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> { return []; }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  getCapabilityConfig(deviceId: DeviceId, capability: CapabilityKind): Record<string, unknown> | null {
    if (capability !== "color") return null;
    const modes = colorModesFromDpt(this.colorDpt.get(deviceId) ?? null);
    return modes ? { colorModes: modes } : null;
  }
}

describe("KNX capability persistence lifecycle (§ P0-C follow-up)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  // § "restart" proof — the SAME store instances are reused across a second
  // AppContext.create() below, exactly like persistence.e2e.test.ts's own restart
  // proof, but in-memory (this suite doesn't need Postgres to prove the persistence
  // SEAM is used correctly — protocolBindingStore/homeStore ARE that seam).
  const protocolBindingStore = new InMemoryProtocolBindingStore();
  const homeStore = new InMemoryHomeStore();

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const engine = new SupremeNativeAdapter({ drivers: [new FakeKnxCapabilityDriver()] });
    const providers = new ProviderRegistry();
    const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore,
      homeStore,
      knxDiscoveryDriverFactory: (config) => new SupremeKnxDriver({ ...config, iotProvider: new FakeEmptyKnxIotProvider() }),
    });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    token = ((await res.json()) as { accessToken: string }).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });
  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  type QueueItem = { device: { suggestedName: string }; plans: unknown; duplicate: { decision: string } };

  async function scan(exportXml: string): Promise<QueueItem[]> {
    const res = await fetch(`${baseUrl}/v1/commissioning/knx/queue`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ gateway: { host: "127.0.0.1" }, content: exportXml }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { queue: QueueItem[] }).queue;
  }

  // § Never assume `queue[0]` — a scan can legitimately return more than one item (this
  // suite's own fixtures already do, once KNX-IoT live discovery is allowed to run
  // alongside the ETS signals — see `FakeEmptyKnxIotProvider` above). Select the queue
  // item that IS the fixture under test by its own known identity (`suggestedName`,
  // derived deterministically from the ETS circuit name), never by position.
  function pickFixture(queue: QueueItem[], n: number): QueueItem {
    const item = queue.find((q) => q.device.suggestedName === `Fixture ${n}`);
    if (!item) throw new Error(`expected a queue item named "Fixture ${n}", got: ${queue.map((q) => q.device.suggestedName).join(", ")}`);
    return item;
  }

  async function approve(item: { device: unknown; plans: unknown }, name: string): Promise<{ device: { id: string; capabilities: { kind: string; config: Record<string, unknown> }[] }; status: string }> {
    const res = await fetch(`${baseUrl}/v1/commissioning/knx/approve`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ device: item.device, name, plans: item.plans }),
    });
    expect(res.status).toBe(201);
    return res.json() as Promise<{ device: { id: string; capabilities: { kind: string; config: Record<string, unknown> }[] }; status: string }>;
  }

  // Anonymized fixture — no real project filename/room name/GA carried over from any
  // real ETS export; "Fixture N" circuits, addresses in an unused test range.
  const fixtureExport = (n: number, colorDpts: string) => `<GroupAddress-Export>
    <GroupAddress Name="Fixture ${n} - Switch" Address="9/${n}/0" DPTs="DPST-1-1" />
    <GroupAddress Name="Fixture ${n} - Switch Status" Address="9/${n}/1" DPTs="DPST-1-1" />
    <GroupAddress Name="Fixture ${n} - Abs Dim" Address="9/${n}/2" DPTs="DPST-5-1" />
    <GroupAddress Name="Fixture ${n} - Abs Dim FB" Address="9/${n}/3" DPTs="DPST-5-1" />
    <GroupAddress Name="Fixture ${n} - Abs Col" Address="9/${n}/4" DPTs="${colorDpts}" />
    <GroupAddress Name="Fixture ${n} - Abs Col FB" Address="9/${n}/5" DPTs="${colorDpts}" />
  </GroupAddress-Export>`;

  it("TEST 1: a new CCT device (DPT 7.600) persists colorModes.cct=true on first approval", async () => {
    const queue = await scan(fixtureExport(1, "DPST-7-600"));
    const item = pickFixture(queue, 1);
    expect(item.duplicate.decision).toBe("new");
    const { device } = await approve(item as { device: unknown; plans: unknown }, "Fixture 1");
    const color = device.capabilities.find((c) => c.kind === "color")!;
    expect(color.config.colorModes).toEqual({ rgb: false, cct: true });
  });

  it("TEST 2: an existing RGB device rediscovered with DPT 7.600 evidence updates the SAME device to CCT — never creates a duplicate", async () => {
    const before = pickFixture(await scan(fixtureExport(2, "DPST-232-600")), 2);
    expect(before.duplicate.decision).toBe("new");
    const approved1 = await approve(before as { device: unknown; plans: unknown }, "Fixture 2");
    const colorBefore = approved1.device.capabilities.find((c) => c.kind === "color")!;
    expect(colorBefore.config.colorModes).toEqual({ rgb: true, cct: false });

    const devicesBefore = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json() as { rooms: { devices?: unknown[] }[] }).rooms.flatMap((r) => r.devices ?? []);

    // § Re-import/re-scan — the SAME circuit's group addresses, but the (anonymized)
    // ETS evidence now reports DPT 7.600 instead of 232.600 (e.g. the installer
    // corrected a mis-tagged DPT in ETS, or upgraded the fixture's actuator). Every
    // communication object is already bound to the device just approved above, so
    // duplicate-detection must classify this as re-discovery, not a brand-new device.
    const after = pickFixture(await scan(fixtureExport(2, "DPST-7-600")), 2);
    // § the status GAs are never recorded in `boundAddresses` (only write addresses
    // are — see TEST 3's own note), so a device with separate write/status objects
    // lands in "ask_installer" here, not "merge" — real re-discovery evidence either
    // way, since `findSoleExistingKnxOwner` keys off the WRITE addresses, not the label.
    expect(after.duplicate.decision).toBe("ask_installer");
    const approved2 = await approve(after as { device: unknown; plans: unknown }, "Fixture 2");

    // Same device, not a new one.
    expect(approved2.device.id).toBe(approved1.device.id);
    const devicesAfter = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json() as { rooms: { devices?: unknown[] }[] }).rooms.flatMap((r) => r.devices ?? []);
    expect(devicesAfter.length).toBe(devicesBefore.length); // no duplicate device created

    const colorAfter = approved2.device.capabilities.find((c) => c.kind === "color")!;
    expect(colorAfter.config.colorModes).toEqual({ rgb: false, cct: true }); // flipped, matching the P0-C follow-up's exact fixture
  });

  it("TEST 3: an existing RGB device rediscovered with the SAME DPT evidence stays RGB — no spurious flip", async () => {
    const first = pickFixture(await scan(fixtureExport(3, "DPST-232-600")), 3);
    const approved1 = await approve(first as { device: unknown; plans: unknown }, "Fixture 3");
    const second = pickFixture(await scan(fixtureExport(3, "DPST-232-600")), 3);
    // § Every capability's WRITE group address already belongs to the device just
    // approved above, so `findSoleExistingKnxOwner` resolves the SAME existing device
    // regardless of which duplicate-decision label `checkDuplicate` assigns here — the
    // status GAs (never recorded in `boundAddresses`, only write addresses are) mean a
    // device with separate write/status objects lands in "ask_installer" ("some but not
    // ALL of this device's group addresses are already bound"), not "merge" — real,
    // pre-existing `checkDuplicate` behavior, not something this fix changes.
    expect(second.duplicate.decision).toBe("ask_installer");
    const approved2 = await approve(second as { device: unknown; plans: unknown }, "Fixture 3");
    expect(approved2.device.id).toBe(approved1.device.id);
    const color = approved2.device.capabilities.find((c) => c.kind === "color")!;
    expect(color.config.colorModes).toEqual({ rgb: true, cct: false });
  });

  it("TEST 5: a CCT-only device (no RGB objects anywhere in its plan) persists cct=true, rgb=false", async () => {
    const item = pickFixture(await scan(fixtureExport(5, "DPST-7-600")), 5);
    const { device } = await approve(item as { device: unknown; plans: unknown }, "Fixture 5");
    const color = device.capabilities.find((c) => c.kind === "color")!;
    expect(color.config.colorModes).toEqual({ rgb: false, cct: true });
    expect(color.config.colorModes).not.toMatchObject({ rgb: true });
  });

  it("TEST 6: colorModes survives a simulated gateway restart (fresh AppContext over the SAME persisted stores)", async () => {
    const item = pickFixture(await scan(fixtureExport(6, "DPST-7-600")), 6);
    const { device } = await approve(item as { device: unknown; plans: unknown }, "Fixture 6");
    const deviceId = device.id;

    // Simulate a restart: a BRAND NEW AppContext/server/SIL/driver instance, reusing
    // ONLY the persisted stores — nothing about the running process survives, exactly
    // like a real gateway process restart. If colorModes only lived in the old
    // process's in-memory driver state, this would come back empty/stale.
    const registry2 = new EntityRegistryMirror();
    const engine2 = new SupremeNativeAdapter({ drivers: [new FakeKnxCapabilityDriver()] });
    const providers2 = new ProviderRegistry();
    const router2 = new ProviderRouter({ engine: engine2, registry: providers2, bindingEngine: new DriverBindingEngine(engine2, providers2) });
    const sil2 = new SupremeIntegrationLayer({ adapter: router2, registry: registry2 });
    const ctx2 = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), { sil: sil2, protocolBindingStore, homeStore });
    try {
      const restarted = await ctx2.home.getDevice(deviceId as DeviceId);
      expect(restarted).not.toBeNull();
      const color = restarted!.capabilities.find((c) => c.kind === "color")!;
      expect(color.config.colorModes).toEqual({ rgb: false, cct: true });
    } finally {
      await ctx2.shutdown();
    }
  });

  it("TEST 9/10: ON/OFF and brightness bindings are unaffected by any of the above — the color-only refresh path never touches other capabilities", async () => {
    const item = pickFixture(await scan(fixtureExport(9, "DPST-7-600")), 9);
    const { device } = await approve(item as { device: unknown; plans: unknown }, "Fixture 9");
    const rescanItem = pickFixture(await scan(fixtureExport(9, "DPST-7-600")), 9);
    const reapproved = await approve(rescanItem as { device: unknown; plans: unknown }, "Fixture 9");
    expect(reapproved.device.id).toBe(device.id);
    const onoff = reapproved.device.capabilities.find((c) => c.kind === "onoff");
    const brightness = reapproved.device.capabilities.find((c) => c.kind === "brightness");
    expect(onoff).toBeDefined();
    expect(brightness).toBeDefined();
  });
});
