import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  InMemoryProtocolBindingStore,
  HaAdapter,
  HomeAssistantProviderDriver,
  DriverBindingEngine,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type DiscoveredDevice,
  type HaTransport,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/** A native driver whose command() always fails — simulates a device that's bound but
 * genuinely unreachable (wrong IP, receiver off, Docker networking can't reach the LAN…). */
class FlakyDriver implements INativeProtocolDriver {
  readonly protocol = "flaky";
  private readonly devices = new Set<DeviceId>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(): Promise<void> { throw new Error("flaky: not connected to 10.0.0.99:23"); }
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> { return []; }
  onState(_l: StateListener): () => void { return () => {}; }
}

/** No-socket HA transport (mirrors integration-layer's own ha-adapter.test.ts pattern) —
 * registered so demo-seeded devices (which map onto "homeassistant" per ADR-0023 §
 * Commissioning) are genuinely bound, exactly like a real hub with HA configured. */
class FakeHaTransport implements HaTransport {
  opened = false;
  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }
  isOpen(): boolean { return this.opened; }
  onEvent(): void {}
  async send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (message.type === "get_states") return { result: [] };
    return {};
  }
}

describe("Settings → Logs (§ Diagnostics): unified system log", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const haDriver = new HomeAssistantProviderDriver(new HaAdapter({ transport: new FakeHaTransport(), registry }), registry);
    const routerEngine0 = new SupremeNativeAdapter({ drivers: [new FlakyDriver(), haDriver] });
    const routerProviders0 = new ProviderRegistry();
    const router = new ProviderRouter({ engine: routerEngine0, registry: routerProviders0, bindingEngine: new DriverBindingEngine(routerEngine0, routerProviders0) })
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore: new InMemoryProtocolBindingStore(),
    });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
  async function login() {
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    return ((await res.json()) as { accessToken: string }).accessToken;
  }

  it("logs a successful device command and a failed one, both retrievable from /v1/system/logs", async () => {
    const token = await login();

    // A real seeded device — commanding it should succeed and log an "info" entry.
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth(token) })).json()) as {
      rooms: { id: string; name: string }[];
    };
    const living = home.rooms.find((r) => r.name === "Living Room")!;
    const devices = (await (await fetch(`${baseUrl}/v1/rooms/${living.id}/devices`, { headers: auth(token) })).json()) as {
      devices: { id: string; name: string; capabilities: { kind: string }[] }[];
    };
    const light = devices.devices.find((d) => d.capabilities.some((c) => c.kind === "onoff"))!;
    const ok = await fetch(`${baseUrl}/v1/devices/${light.id}/command`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ command: { capability: "onoff", action: "on" } satisfies CapabilityCommand }),
    });
    expect(ok.status).toBe(200);

    // A device bound to the FlakyDriver — commanding it must fail AND be logged, not silently
    // swallowed (the exact bug this feature exists to make visible).
    const commissionRes = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        backendId: "flaky:1",
        name: "Unreachable Receiver",
        roomId: living.id,
        capabilities: ["onoff"],
        protocol: "flaky",
        address: "10.0.0.99:23",
      }),
    });
    expect(commissionRes.status).toBe(201);
    const { device: flakyDevice } = (await commissionRes.json()) as { device: { id: string } };

    const failed = await fetch(`${baseUrl}/v1/devices/${flakyDevice.id}/command`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ command: { capability: "onoff", action: "on" } satisfies CapabilityCommand }),
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);

    const logsRes = await fetch(`${baseUrl}/v1/system/logs`, { headers: auth(token) });
    expect(logsRes.status).toBe(200);
    const { entries } = (await logsRes.json()) as { entries: { level: string; source: string; message: string }[] };

    expect(entries.some((e) => e.level === "info" && e.source === `Device: ${light.name}` && e.message.includes("onoff command sent"))).toBe(true);
    expect(entries.some((e) => e.level === "error" && e.source === "Device: Unreachable Receiver" && e.message.includes("not connected"))).toBe(true);
  });
});
