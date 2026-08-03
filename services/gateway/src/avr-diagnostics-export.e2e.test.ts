import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
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
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * A fake AVR-shaped native driver that opts into `exportDiagnosticsLog` (§ AVR
 * Diagnostic Mode) — proving GET /v1/devices/:id/diagnostics/export actually reaches
 * the owning driver and streams back its log as a downloadable `diagnostic.log`.
 */
class FakeDiagnosticsCapableAvr implements INativeProtocolDriver {
  readonly protocol = "avr";
  private readonly devices = new Set<DeviceId>();
  private readonly listeners = new Set<StateListener>();
  logToReturn: string | null = "AVR-000001 [TCP] received=\"MV63\"";

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(): Promise<void> {}
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> {
    return [{ backendId: "192.168.1.81", suggestedName: "Media Room AVR", capabilities: ["onoff", "media"], raw: { protocol: "avr" } }];
  }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  exportDiagnosticsLog(): string | null {
    return this.logToReturn;
  }
}

describe("AVR Diagnostic Mode export (§ AVR Diagnostic Mode): GET /v1/devices/:id/diagnostics/export", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let driver: FakeDiagnosticsCapableAvr;
  let deviceId: DeviceId;

  beforeAll(async () => {
    driver = new FakeDiagnosticsCapableAvr();
    const registry = new EntityRegistryMirror();
    const routerEngine0 = new SupremeNativeAdapter({ drivers: [driver] });
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
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    token = ((await res.json()) as { accessToken: string }).accessToken;

    const homeRes = await fetch(`${baseUrl}/v1/home`, { headers: auth() });
    const roomId = ((await homeRes.json()) as { rooms: { id: string }[] }).rooms[0]!.id;
    const devRes = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ backendId: "192.168.1.81", name: "Media Room AVR", roomId, capabilities: ["media"] }),
    });
    deviceId = ((await devRes.json()) as { device: { id: DeviceId } }).device.id;
    const bindRes = await fetch(`${baseUrl}/v1/commissioning/bind`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ deviceId, capability: "media", protocol: "avr", address: "192.168.1.81" }),
    });
    expect(bindRes.status).toBe(201);
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  function auth() {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  it("streams the owning driver's diagnostic log as a downloadable diagnostic.log file", async () => {
    const res = await fetch(`${baseUrl}/v1/devices/${deviceId}/diagnostics/export`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition")).toContain('filename="diagnostic.log"');
    expect(await res.text()).toBe(driver.logToReturn);
  });

  it("404s when diagnostics isn't enabled for the owning driver instance", async () => {
    driver.logToReturn = null;
    const res = await fetch(`${baseUrl}/v1/devices/${deviceId}/diagnostics/export`, { headers: auth() });
    expect(res.status).toBe(404);
    driver.logToReturn = "AVR-000001 [TCP] received=\"MV63\"";
  });

  it("404s for a device that doesn't exist", async () => {
    const res = await fetch(`${baseUrl}/v1/devices/device-nope/diagnostics/export`, { headers: auth() });
    expect(res.status).toBe(404);
  });
});
