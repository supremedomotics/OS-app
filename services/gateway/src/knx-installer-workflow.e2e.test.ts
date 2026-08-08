import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  InMemoryProtocolBindingStore,
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
import type { HomeView } from "@supreme/contracts";
import {
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

/** A live-enough fake KNX driver — records bindings, reports ownership on demand, so
 * approveKnxDevice()'s Live Validation stage (§ Phase 5) has something real to check
 * against without a physical bus. */
class FakeKnx implements INativeProtocolDriver {
  readonly protocol = "knx";
  private readonly devices = new Set<DeviceId>();
  private readonly listeners = new Set<StateListener>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(_id: DeviceId, _c: CapabilityCommand): Promise<void> {}
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> { return []; }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

/** § Test isolation fix — this suite hits the real HTTP installer route, which builds a
 * REAL `SupremeKnxDriver` for discovery via `InstallerServices.knxDiscoveryDriver()`
 * (never `FakeKnx` above — that's only the "knx" protocol's live command/binding driver,
 * a completely different object). Left unmocked, `SupremeKnxDriver`'s default
 * `KnxIotProvider` performs REAL CoAP multicast discovery on whatever network this suite
 * runs on, picking up real/other KNX-IoT devices and making the resulting queue length
 * nondeterministic (observed: expected 1, got 3; expected 0, got 2).
 *
 * This fake implements the same `IKnxProvider` seam `SupremeKnxDriver` already supports
 * for tests (see services/protocols/src/knx/supreme-knx-driver.test.ts's own
 * `FakeKnxIotProvider`) — `discover()` deterministically returns no devices, so every
 * device in this suite's queue comes from the ETS signals under test, never from
 * whatever happens to be on the network. Every other stage of the real pipeline
 * (`discoverUnified()`, ETS merge, grouping, capability mapping) is exercised unchanged. */
class FakeEmptyKnxIotProvider implements IKnxProvider {
  readonly name = "fake-empty-knx-iot";
  async initialize(): Promise<void> {}
  async discover(): Promise<DiscoveredDevice[]> { return []; }
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
 * Production KNX onboarding pipeline (§ Phase 5): the real HTTP surface an installer
 * client calls — Scan → discoverUnified() → Confidence/Room/Duplicate/Binding engines →
 * Installer Queue → Approve → commissionDevice()/bindProtocol() → live device. Exercises
 * the actual gateway routes, not the InstallerServices methods directly, so this proves
 * the wiring end-to-end (auth, routing, serialization) the way a real client hits it.
 */
describe("KNX Unified Device Intelligence — installer workflow", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const routerEngine0 = new SupremeNativeAdapter({ drivers: [new FakeKnx()] });
    const routerProviders0 = new ProviderRegistry();
    const router = new ProviderRouter({ engine: routerEngine0, registry: routerProviders0, bindingEngine: new DriverBindingEngine(routerEngine0, routerProviders0) })
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore: new InMemoryProtocolBindingStore(),
      // § Test isolation fix — see FakeEmptyKnxIotProvider's own doc comment. Builds the
      // REAL SupremeKnxDriver (discoverUnified(), ETS merge, grouping, capability mapping
      // all stay real); only the physical CoAP multicast discovery is deterministic.
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

  it(
    "runs the full pipeline: ETS signals in → intelligent queue out, with real binding plans and confidence scores",
    async () => {
      const res = await fetch(`${baseUrl}/v1/commissioning/knx/queue`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          gateway: { host: "127.0.0.1" }, // no driver installed — override, real (empty) discovery
          ets: [
            { id: "1/1/1", name: "Kitchen Light SW", room: "Kitchen" },
            { id: "1/1/2", name: "Kitchen Light STATUS", room: "Kitchen" },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        queue: Array<Record<string, unknown>>;
        summary: {
          totalGroupAddresses: number;
          circuitsCreated: number;
          devicesCreated: number;
          duplicateCircuits: number;
          unsupportedObjects: number;
          readyCount: number;
          needsReviewCount: number;
          discoveryDurationMs: number;
          groupAddressSchema: string;
        };
      };
      expect(body.queue).toHaveLength(1);

      const item = body.queue[0]!;
      expect((item.device as { suggestedName: string }).suggestedName).toBe("Kitchen Light");
      expect((item.device as { capabilities: string[] }).capabilities).toContain("onoff");
      expect((item.room as { room: string }).room).toBe("Kitchen");
      expect((item.duplicate as { decision: string }).decision).toBe("new");
      expect(item.section).toBe("ready"); // real GA present, fully bindable, no duplicate
      const plans = item.plans as Array<{ address: string; bindable: boolean }>;
      expect(plans[0]).toMatchObject({ address: "1/1/1", bindable: true });

      // Discovery Summary (§ Discover Devices Summary) — aggregates what the engines
      // above already computed, nothing re-derived.
      expect(body.summary).toMatchObject({
        totalGroupAddresses: 2, // the 2 ETS signals for this one circuit
        circuitsCreated: 1,
        devicesCreated: 1,
        duplicateCircuits: 0,
        unsupportedObjects: 0,
        readyCount: 1,
        needsReviewCount: 0,
        groupAddressSchema: "auto", // no driver installed / no explicit schema → schema-less trailing-operation-word grouping
      });
      expect(body.summary.discoveryDurationMs).toBeGreaterThanOrEqual(0);
    },
    10000,
  );

  it("approves a queued device in one action: commission + bind + validate, no second config step", async () => {
    const queueRes = await fetch(`${baseUrl}/v1/commissioning/knx/queue`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        gateway: { host: "127.0.0.1" },
        ets: [{ id: "2/2/2", name: "Hallway Switch" }],
      }),
    });
    const { queue } = (await queueRes.json()) as { queue: Array<{ device: unknown; plans: unknown }> };
    expect(queue).toHaveLength(1);

    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const roomId = home.rooms[0]!.id;

    const approveRes = await fetch(`${baseUrl}/v1/commissioning/knx/approve`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ device: queue[0]!.device, name: "Hallway Switch", roomId, plans: queue[0]!.plans }),
    });
    expect(approveRes.status).toBe(201);
    const approved = (await approveRes.json()) as { device: { id: string; name: string }; status: string };
    expect(approved.status).toBe("ready"); // FakeKnx reports ownership → Live Validation passes
    expect(approved.device.name).toBe("Hallway Switch");

    // No second configuration step: the device is immediately live in the room.
    const devices = (await (await fetch(`${baseUrl}/v1/rooms/${roomId}/devices`, { headers: auth() })).json()) as {
      devices: { id: string; name: string; capabilities: { kind: string }[] }[];
    };
    const live = devices.devices.find((d) => d.id === approved.device.id);
    expect(live).toBeTruthy();
    expect(live?.capabilities.map((c) => c.kind)).toContain("onoff");

    const bindings = (await (await fetch(`${baseUrl}/v1/commissioning/bindings`, { headers: auth() })).json()) as {
      bindings: { deviceId: string; protocol: string; address: string }[];
    };
    expect(bindings.bindings.some((b) => b.deviceId === approved.device.id && b.protocol === "knx" && b.address === "2/2/2")).toBe(true);
  }, 10000);

  it("rolls back cleanly when approving a device with no bindable communication object", async () => {
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const roomId = home.rooms[0]!.id;

    // A KNX-IoT-only device (no group address) never produces a bindable plan (§ Phase 4
    // Binding Engine) — approval must reject before creating anything, not commission
    // then fail.
    const queueRes = await fetch(`${baseUrl}/v1/commissioning/knx/queue`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ gateway: { host: "127.0.0.1" } }), // no ETS, no real KNX IoT device on the network
    });
    const { queue } = (await queueRes.json()) as { queue: unknown[] };
    expect(queue).toHaveLength(0); // nothing discovered at all — honest, not fabricated

    // Directly exercise the rejection path with a synthetic non-bindable device shape.
    const approveRes = await fetch(`${baseUrl}/v1/commissioning/knx/approve`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        device: { backendId: "knx-unified:test", suggestedName: "Test", capabilities: ["onoff"], raw: { metadata: {} } },
        name: "Test",
        roomId,
        plans: [{ capability: "onoff", address: null, config: { dpt: "1.001" }, bindable: false, reason: "no GA", sourceObjects: [] }],
      }),
    });
    expect(approveRes.status).toBe(422);

    const devicesAfter = (await (await fetch(`${baseUrl}/v1/rooms/${roomId}/devices`, { headers: auth() })).json()) as { devices: { name: string }[] };
    expect(devicesAfter.devices.some((d) => d.name === "Test")).toBe(false); // nothing leaked through
  }, 10000);
});

/** § Development Strategy Part 4 — ETS + KNX-IoT correlation.
 *
 * Before writing these tests, the actual correlation mechanism was inspected, not assumed
 * (services/protocols/src/knx/unified-device-mapper.ts +
 * packages/domain-model/src/device-grouping.ts):
 *
 *   - KnxIotProvider.discover()'s REAL, documented CoAP `/.well-known/core` response only
 *     ever yields a `host` (IP) and a `linkFormat` string (which may carry a self-
 *     advertised `title=`) — no KNX Individual Address, no serial number, no group-address
 *     mapping. `discovery.resource_model`/`discovery.semantic` (which the KNX IoT Point API
 *     spec could in principle carry stronger identity through) are honestly left
 *     unimplemented — this codebase's own comment says why: no live device exists in this
 *     environment to validate a real GET/parse cycle against, so it isn't guessed at.
 *   - `mapUnifiedDevices()` correlates KNX-IoT and ETS signals by feeding BOTH into the
 *     exact same protocol-agnostic `groupByCircuitName` engine used to fuse an ETS
 *     circuit's own SW/STATUS pairs — i.e. cross-source correlation today is NAME-BASED,
 *     the same mechanism, not a separate identity/correlation layer.
 *
 * Conclusion, reached from that evidence, not decided in advance: this IS a real,
 * disclosed architectural gap relative to the SupremeOS Development Strategy's "authoritative
 * protocol data over guesses" / "deterministic and trustworthy commissioning" goals — but it
 * is NOT a bug to silently patch here. A stronger identity signal does not exist to fabricate
 * (that would itself violate "never fabricate data"), and building one requires a live device
 * to validate a real `discovery.resource_model` GET/parse cycle against, which this
 * environment doesn't have — exactly the same honesty bar `KnxIotProvider` itself already
 * holds. Silently forcing/hiding a stronger match, or blindly trusting every name match, would
 * both be worse than the current, disclosed, name-based-with-full-provenance behavior.
 *
 * So these tests validate what the architecture ACTUALLY, SAFELY guarantees today:
 *   Test B1 — when the only available evidence (names) genuinely agrees, KNX-IoT and ETS
 *             signals for the same circuit DO merge into one device, and every merged
 *             communication object still carries its own `source` ("ets"/"knx_iot") — the
 *             correlation is real, but never opaque; a consumer can always see it happened.
 *   Test B2 — when that evidence does NOT agree (the realistic case — most real KNX-IoT
 *             devices advertise a manufacturer/model string, not the installer's ETS
 *             circuit name), the system does NOT invent a relationship: two independent
 *             devices stay two independent queue items. No silent merge, no duplicate
 *             hidden, no fabricated identity.
 */
describe("KNX Unified Device Intelligence — ETS + KNX-IoT correlation (§ Development Strategy Part 4)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  /** Mutated per-test (queue is a fresh HTTP request each time — knxDiscoveryDriver()
   * constructs a fresh SupremeKnxDriver per call, never cached — so this is safely
   * reassignable between `it()` blocks sharing one beforeAll-built server). */
  let scriptedIotDevices: DiscoveredDevice[] = [];

  /** A deterministic, scripted KNX-IoT provider — never the physical network. Returns
   * exactly whatever `scriptedIotDevices` holds at request time; `execute()` for
   * `discovery.functional_blocks` throws (matches a real device that hasn't answered a
   * `/fb` GET yet — `discoverUnified()` already treats that as "no functional blocks
   * available", not an error, see its own try/catch), so classification falls back to the
   * title/name-based path under test. */
  class ScriptedKnxIotProvider implements IKnxProvider {
    readonly name = "scripted-knx-iot";
    async initialize(): Promise<void> {}
    async discover(): Promise<DiscoveredDevice[]> { return scriptedIotDevices; }
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}
    async shutdown(): Promise<void> {}
    async execute(_task: KnxTask): Promise<unknown> { throw new Error("no functional-block response for this fixture device"); }
    subscribe(): void { throw new Error("not applicable"); }
    unsubscribe(): void {}
    health(): KnxProviderHealth { return { connected: true, lastError: null }; }
    diagnostics(): KnxProviderDiagnostics {
      return { provider: this.name, connected: true, packetsSent: 0, packetsReceived: 0, lastTelegramAt: null, lastCommandAt: null, lastError: null, reconnectAttempts: 0 };
    }
  }

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const routerEngineB = new SupremeNativeAdapter({ drivers: [new FakeKnx()] });
    const routerProvidersB = new ProviderRegistry();
    const router = new ProviderRouter({ engine: routerEngineB, registry: routerProvidersB, bindingEngine: new DriverBindingEngine(routerEngineB, routerProvidersB) });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore: new InMemoryProtocolBindingStore(),
      knxDiscoveryDriverFactory: (config) => new SupremeKnxDriver({ ...config, iotProvider: new ScriptedKnxIotProvider() }),
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
  const kitchenEts = [
    { id: "1/1/1", name: "Kitchen Light SW", room: "Kitchen" },
    { id: "1/1/2", name: "Kitchen Light STATUS", room: "Kitchen" },
  ];

  it("Test B1 — matching identity evidence: KNX-IoT and ETS signals for the SAME circuit merge into one device, provenance preserved per communication object", async () => {
    scriptedIotDevices = [{
      backendId: "knx-iot:10.0.0.50",
      suggestedName: "10.0.0.50",
      capabilities: [],
      raw: { host: "10.0.0.50", port: 5683, linkFormat: '</dev>;title="Kitchen Light"', source: "knx-iot" },
    }];

    const res = await fetch(`${baseUrl}/v1/commissioning/knx/queue`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ gateway: { host: "127.0.0.1" }, ets: kitchenEts }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      queue: Array<{ device: { suggestedName: string; raw: { communicationObjects: Array<{ id: string; source: string }> } } }>;
      summary: { totalGroupAddresses: number; circuitsCreated: number; devicesCreated: number };
    };

    // ONE logical device — the only available evidence (circuit name, after the same
    // stopword-stripping ETS's own SW/STATUS pair already goes through) genuinely agreed.
    expect(body.queue).toHaveLength(1);
    expect(body.summary.circuitsCreated).toBe(1);
    expect(body.summary.devicesCreated).toBe(1);

    const item = body.queue[0]!;
    expect(item.device.suggestedName).toBe("Kitchen Light");

    // The merge is never opaque: all 3 communication objects (2 ETS + 1 KNX-IoT) are
    // present, each still tagged with exactly where it came from — a consumer (installer
    // UI, duplicate detection, a future stronger-identity pass) can always tell this device
    // was cross-source-correlated, never a silently blended fabrication.
    expect(body.summary.totalGroupAddresses).toBe(3);
    const sources = item.device.raw.communicationObjects.map((o) => o.source).sort();
    expect(sources).toEqual(["ets", "ets", "knx_iot"]);
    expect(item.device.raw.communicationObjects.some((o) => o.id === "1/1/1")).toBe(true);
    expect(item.device.raw.communicationObjects.some((o) => o.id === "1/1/2")).toBe(true);
    expect(item.device.raw.communicationObjects.some((o) => o.id === "10.0.0.50")).toBe(true);
  });

  it("Test B2 — NO matching identity evidence: an unrelated KNX-IoT device never gets fabricated into the ETS circuit — two independent devices, not a false merge", async () => {
    // Realistic case: a device that hasn't been given (or doesn't advertise) a name
    // matching the installer's ETS project — e.g. its own raw model/serial string. This is
    // the common case for real KNX-IoT hardware, not a contrived edge case.
    scriptedIotDevices = [{
      backendId: "knx-iot:10.0.0.51",
      suggestedName: "10.0.0.51",
      capabilities: [],
      raw: { host: "10.0.0.51", port: 5683, linkFormat: '</dev>;title="Device-A1B2C3"', source: "knx-iot" },
    }];

    const res = await fetch(`${baseUrl}/v1/commissioning/knx/queue`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ gateway: { host: "127.0.0.1" }, ets: kitchenEts }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      queue: Array<{ device: { suggestedName: string; raw: { communicationObjects: Array<{ id: string; source: string }> } } }>;
      summary: { totalGroupAddresses: number; circuitsCreated: number; devicesCreated: number };
    };

    // TWO independent devices — no shared evidence, so no invented relationship. The
    // system must never silently merge, and must never silently drop the unrelated device
    // either (that would hide a real, discovered device from the installer).
    expect(body.queue).toHaveLength(2);
    expect(body.summary.circuitsCreated).toBe(2);
    expect(body.summary.devicesCreated).toBe(2);
    expect(body.summary.totalGroupAddresses).toBe(3); // same 3 raw objects, just not blended

    const kitchen = body.queue.find((i) => i.device.suggestedName === "Kitchen Light");
    expect(kitchen).toBeTruthy();
    expect(kitchen!.device.raw.communicationObjects.map((o) => o.source).sort()).toEqual(["ets", "ets"]);

    const orphanIot = body.queue.find((i) => i.device.raw.communicationObjects.some((o) => o.source === "knx_iot"));
    expect(orphanIot).toBeTruthy();
    expect(orphanIot!.device.raw.communicationObjects).toHaveLength(1);
    expect(orphanIot!.device.raw.communicationObjects[0]!.id).toBe("10.0.0.51");
    // Never fabricated into the Kitchen Light circuit.
    expect(orphanIot).not.toBe(kitchen);
  });
});

describe("KNX ETS Import unified into the Discovery Queue (§ Unify ETS Import & Discovery Pipeline)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const routerEngine1 = new SupremeNativeAdapter({ drivers: [new FakeKnx()] });
    const routerProviders1 = new ProviderRegistry();
    const router = new ProviderRouter({ engine: routerEngine1, registry: routerProviders1, bindingEngine: new DriverBindingEngine(routerEngine1, routerProviders1) })
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    // § Test isolation fix — see FakeEmptyKnxIotProvider's own doc comment.
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore: new InMemoryProtocolBindingStore(),
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

  it(
    "an ETS group-address export POSTed to the SAME /knx/queue route produces a real queue item through the identical Confidence/Room/Duplicate/Binding pipeline live discovery uses — no separate ETS commissioning path",
    async () => {
      const content = `<GroupAddress-Export>
        <GroupAddress Name="Living Room - Reading Lamp - Switch" Address="1/2/1" DPTs="DPST-1-1" />
        <GroupAddress Name="Living Room - Reading Lamp - Status" Address="1/2/3" DPTs="DPST-1-1" />
      </GroupAddress-Export>`;
      const res = await fetch(`${baseUrl}/v1/commissioning/knx/queue`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ gateway: { host: "127.0.0.1" }, content }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { queue: Array<Record<string, unknown>>; summary: { totalGroupAddresses: number } };
      expect(body.queue).toHaveLength(1);
      const item = body.queue[0]!;
      // Went through the exact same engines a live-discovered device does: a real
      // confidence score, a real duplicate decision, a real binding plan with the ETS
      // group address as the write address — not a separate legacy shape.
      // No structured ETS Function/Space tree in this flat export, so room isn't split out
      // separately — the full dash-separated circuit name is the correct suggestion.
      expect((item.device as { suggestedName: string }).suggestedName).toBe("Living Room Reading Lamp");
      expect((item.confidence as { overall: number }).overall).toBeGreaterThan(0);
      expect((item.duplicate as { decision: string }).decision).toBe("new");
      const plans = item.plans as Array<{ address: string; bindable: boolean }>;
      expect(plans[0]).toMatchObject({ address: "1/2/1", bindable: true });
      expect(body.summary.totalGroupAddresses).toBe(2);
    },
    10000,
  );

  it("an ETS-sourced device approves through the exact same approval endpoint as a live-discovered device", async () => {
    const content = `<GroupAddress-Export>
      <GroupAddress Name="Hallway - Ceiling Light - Switch" Address="1/3/1" DPTs="DPST-1-1" />
    </GroupAddress-Export>`;
    const queueRes = await fetch(`${baseUrl}/v1/commissioning/knx/queue`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ gateway: { host: "127.0.0.1" }, content }),
    });
    const { queue } = (await queueRes.json()) as { queue: Array<{ device: unknown; plans: unknown }> };
    expect(queue).toHaveLength(1);

    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const roomId = home.rooms[0]!.id;
    const approveRes = await fetch(`${baseUrl}/v1/commissioning/knx/approve`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ device: queue[0]!.device, name: "Ceiling Light", roomId, plans: queue[0]!.plans }),
    });
    expect(approveRes.status).toBe(201);
    const approved = (await approveRes.json()) as { status: string };
    expect(approved.status).toBe("ready");

    const bindings = (await (await fetch(`${baseUrl}/v1/commissioning/bindings`, { headers: auth() })).json()) as { bindings: { address: string; protocol: string }[] };
    expect(bindings.bindings.some((b) => b.address === "1/3/1" && b.protocol === "knx")).toBe(true);
  }, 10000);

  it("rejects an ETS export with no group addresses instead of silently returning an empty queue", async () => {
    const res = await fetch(`${baseUrl}/v1/commissioning/knx/queue`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ gateway: { host: "127.0.0.1" }, content: "<GroupAddress-Export></GroupAddress-Export>" }),
    });
    expect(res.status).toBe(422);
  });
});

/**
 * Automatic Room Creation (§ Generic Room Assignment Engine): approving a device with NO
 * `roomId` must never require the installer to pre-create a room. The engine finds an
 * existing room by name when one matches, and creates a new one otherwise — reusing the
 * exact same `resolveOrCreateRoom` the legacy ETS one-shot import and Casambi-style
 * `/v1/commissioning/auto` already relied on, now shared by the Discovery Queue's approve
 * path too (no per-driver room-creation logic).
 */
describe("KNX Automatic Room Creation (§ Generic Room Assignment Engine)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const routerEngine2 = new SupremeNativeAdapter({ drivers: [new FakeKnx()] });
    const routerProviders2 = new ProviderRegistry();
    const router = new ProviderRouter({ engine: routerEngine2, registry: routerProviders2, bindingEngine: new DriverBindingEngine(routerEngine2, routerProviders2) })
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore: new InMemoryProtocolBindingStore(),
      // § Test isolation fix — see FakeEmptyKnxIotProvider's own doc comment.
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

  it("creates a new room from the queue's own room hint when no matching room exists and no roomId is supplied", async () => {
    const before = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    expect(before.rooms.some((r) => r.name === "Attic")).toBe(false);

    // A flat GA export carries no structured room metadata (§ never fabricate — room stays
    // null unless a source actually provides it), so this uses the `ets` signal shape's own
    // `room` field directly — the same tier-1 "signal-provided room" path live KNX IoT
    // discovery and richer .knxproj Function/Space trees both feed into Room Assignment.
    const queueRes = await fetch(`${baseUrl}/v1/commissioning/knx/queue`, {
      method: "POST",
      headers: auth(),
      // § Correctness Fix (Capability Audit Phase 1) — deliberately NOT named with a
      // "fan"/"ventilation" token: the KNX capability mapper no longer classifies
      // those as a bindable capability at all (knx-codec.ts can't execute a fan
      // command), so a device named that way would have zero bindable plans and
      // fail approval — a fixture-naming collision, not a bug in this test's actual
      // subject (room assignment), which is why the name changed here.
      body: JSON.stringify({ gateway: { host: "127.0.0.1" }, ets: [{ id: "4/1/1", name: "Attic Utility Switch", room: "Attic" }] }),
    });
    const { queue } = (await queueRes.json()) as { queue: Array<{ device: unknown; plans: unknown; room: { room: string | null } }> };
    expect(queue).toHaveLength(1);
    expect(queue[0]!.room.room).toBe("Attic");

    const approveRes = await fetch(`${baseUrl}/v1/commissioning/knx/approve`, {
      method: "POST",
      headers: auth(),
      // No roomId at all — this is the case that used to require a pre-existing room.
      body: JSON.stringify({ device: queue[0]!.device, name: "Attic Utility", plans: queue[0]!.plans }),
    });
    expect(approveRes.status).toBe(201);
    const approved = (await approveRes.json()) as { device: { id: string }; status: string };
    expect(approved.status).toBe("ready");

    const after = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const atticRoom = after.rooms.find((r) => r.name === "Attic");
    expect(atticRoom).toBeTruthy();

    const devices = (await (await fetch(`${baseUrl}/v1/rooms/${atticRoom!.id}/devices`, { headers: auth() })).json()) as { devices: { id: string }[] };
    expect(devices.devices.some((d) => d.id === approved.device.id)).toBe(true);
  }, 10000);

  it("reuses an existing room by name instead of creating a duplicate", async () => {
    const before = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const atticRoom = before.rooms.find((r) => r.name === "Attic")!;
    expect(atticRoom).toBeTruthy();
    const atticCountBefore = before.rooms.filter((r) => r.name === "Attic").length;

    const queueRes = await fetch(`${baseUrl}/v1/commissioning/knx/queue`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ gateway: { host: "127.0.0.1" }, ets: [{ id: "4/2/1", name: "Storage Light Switch", room: "Attic" }] }),
    });
    const { queue } = (await queueRes.json()) as { queue: Array<{ device: unknown; plans: unknown }> };
    expect(queue).toHaveLength(1);

    const approveRes = await fetch(`${baseUrl}/v1/commissioning/knx/approve`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ device: queue[0]!.device, name: "Storage Light", plans: queue[0]!.plans }),
    });
    expect(approveRes.status).toBe(201);
    const approved = (await approveRes.json()) as { device: { id: string } };

    const after = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    expect(after.rooms.filter((r) => r.name === "Attic").length).toBe(atticCountBefore); // no duplicate room created

    const devices = (await (await fetch(`${baseUrl}/v1/rooms/${atticRoom.id}/devices`, { headers: auth() })).json()) as { devices: { id: string }[] };
    expect(devices.devices.some((d) => d.id === approved.device.id)).toBe(true); // landed in the SAME existing room
  }, 10000);
});
