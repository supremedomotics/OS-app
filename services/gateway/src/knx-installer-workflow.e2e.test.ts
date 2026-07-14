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
  RoutingBackendAdapter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import type { HomeView } from "@supreme/contracts";
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
    const router = new RoutingBackendAdapter({
      ha: new MockAdapter(),
      native: new SupremeNativeAdapter({ drivers: [new FakeKnx()] }),
      registry,
      policy: new MigrationPolicy(),
    });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore: new InMemoryProtocolBindingStore(),
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
      const body = (await res.json()) as { queue: Array<Record<string, unknown>> };
      expect(body.queue).toHaveLength(1);

      const item = body.queue[0]!;
      expect((item.device as { suggestedName: string }).suggestedName).toBe("Kitchen Light");
      expect((item.device as { capabilities: string[] }).capabilities).toContain("onoff");
      expect((item.room as { room: string }).room).toBe("Kitchen");
      expect((item.duplicate as { decision: string }).decision).toBe("new");
      expect(item.section).toBe("ready"); // real GA present, fully bindable, no duplicate
      const plans = item.plans as Array<{ address: string; bindable: boolean }>;
      expect(plans[0]).toMatchObject({ address: "1/1/1", bindable: true });
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
