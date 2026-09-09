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
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * § Casambi Device-Kind Override — exercises the REAL /v1/commissioning/commission endpoint
 * (the same path `discover.tsx`'s "Add device" button drives — see
 * `casambi-room-assignment.e2e.test.ts` for the same harness convention) with `kindOverride`,
 * proving:
 *   - "keypad" lands as a 0-capability device-level mapping (never a capability binding),
 *     reusing the exact same exemption Stage 1's real Casambi keypad commissioning relies on.
 *   - "curtain"/"onoff_relay"/"light" override the device's supremeType and (when the kind
 *     implies a different capability set) the capabilities actually committed AND bound —
 *     never the driver's raw pre-override capabilities.
 *   - "ir_blaster" fails loudly (no real IR capability exists yet) rather than silently
 *     misclassifying or fabricating one.
 */
class FakeCasambi implements INativeProtocolDriver {
  readonly protocol = "casambi";
  readonly bindings: ProtocolBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly listeners = new Set<StateListener>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> { this.bindings.push(b); this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(): Promise<void> {}
  async command2(_id: DeviceId, _c: CapabilityCommand): Promise<void> {}
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> { return []; }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

describe("Casambi Device-Kind Override — real /v1/commissioning/commission path", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let registry: EntityRegistryMirror;
  let driver: FakeCasambi;

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  beforeAll(async () => {
    registry = new EntityRegistryMirror();
    driver = new FakeCasambi();
    const engine = new SupremeNativeAdapter({ drivers: [driver] });
    const providers = new ProviderRegistry();
    const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
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

  it("kindOverride: 'keypad' with capabilities:[] lands as a 0-capability device-level mapping, never a capability binding", async () => {
    const res = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ backendId: "casambi:10", name: "Rotary switch", capabilities: [], kindOverride: "keypad" }),
    });
    expect(res.status).toBe(201);
    const { device } = (await res.json()) as { device: { id: string; supremeType: string; capabilities: unknown[] } };
    expect(device.supremeType).toBe("keypad");
    expect(device.capabilities).toHaveLength(0);
    // Device-level identity — the registry's own backend mapping, never a capability binding.
    expect(registry.backendIdOfDevice(device.id as DeviceId)).toBe("casambi:10");
    // No protocol driver binding was ever attempted for this device.
    expect(driver.bindings.some((b) => b.deviceId === device.id)).toBe(false);
  });

  it("kindOverride: 'curtain' commits + binds 'position', never the driver's raw pre-override 'onoff'", async () => {
    const res = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        backendId: "casambi:11",
        name: "Curtain motor",
        capabilities: ["onoff"], // the driver's own (wrong) auto-detected guess
        kindOverride: "curtain",
        protocol: "casambi",
        address: "casambi:11",
      }),
    });
    expect(res.status).toBe(201);
    const { device } = (await res.json()) as { device: { id: string; supremeType: string; capabilities: { kind: string }[] } };
    expect(device.supremeType).toBe("cover");
    expect(device.capabilities.map((c) => c.kind)).toEqual(["position"]);
    const bound = driver.bindings.filter((b) => b.deviceId === device.id);
    expect(bound).toHaveLength(1);
    expect(bound[0]!.capability).toBe("position");
  });

  it("kindOverride: 'onoff_relay' sets supremeType 'switch' for an ambiguous bare-onoff unit", async () => {
    const res = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ backendId: "casambi:12", name: "Pantry Switch", capabilities: ["onoff"], kindOverride: "onoff_relay" }),
    });
    expect(res.status).toBe(201);
    const { device } = (await res.json()) as { device: { supremeType: string } };
    expect(device.supremeType).toBe("switch");
  });

  it("kindOverride: 'ir_blaster' fails loudly — no real IR capability exists yet, never silently misclassified", async () => {
    const res = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ backendId: "casambi:13", name: "Ir blaster", capabilities: [], kindOverride: "ir_blaster" }),
    });
    expect(res.status).toBe(422);
  });
});
