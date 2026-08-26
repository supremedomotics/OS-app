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

/** A native driver whose command() always succeeds — a genuinely reachable device,
 * for the "logs a successful command" half of this test. */
class WorkingDriver implements INativeProtocolDriver {
  readonly protocol = "working";
  private readonly devices = new Set<DeviceId>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(): Promise<void> {}
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> { return []; }
  onState(_l: StateListener): () => void { return () => {}; }
}

describe("Settings → Logs (§ Diagnostics): unified system log", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const routerEngine0 = new SupremeNativeAdapter({ drivers: [new FlakyDriver(), new WorkingDriver()] });
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

    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth(token) })).json()) as {
      rooms: { id: string; name: string }[];
    };
    const living = home.rooms.find((r) => r.name === "Living Room")!;

    // A device genuinely bound to a reachable native driver — commanding it should
    // succeed and log an "info" entry.
    const workingRes = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        backendId: "working:1",
        name: "Kitchen Light",
        roomId: living.id,
        capabilities: ["onoff"],
        protocol: "working",
        address: "10.0.0.1:1",
      }),
    });
    expect(workingRes.status).toBe(201);
    const { device: light } = (await workingRes.json()) as { device: { id: string; name: string } };
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
