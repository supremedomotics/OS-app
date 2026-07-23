import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
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
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * A fake AVR-shaped native driver that opts into `sendRaw` (§ RTI Capability Audit,
 * Category C.4) — proving the new POST /v1/devices/:id/raw-command route actually
 * reaches the owning driver with the token verbatim, not just accepts the request.
 */
class FakeRawCapableAvr implements INativeProtocolDriver {
  readonly protocol = "avr";
  readonly rawCalls: { deviceId: DeviceId; token: string }[] = [];
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
    return [{ backendId: "192.168.1.81", suggestedName: "Media Room AVR", capabilities: ["onoff", "media"], raw: { protocol: "avr" } }];
  }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  async sendRaw(deviceId: DeviceId, token: string): Promise<void> {
    this.rawCalls.push({ deviceId, token });
  }
}

describe("Raw command escape hatch (§ RTI Capability Audit, Category C.4): POST /v1/devices/:id/raw-command", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let driver: FakeRawCapableAvr;
  let rawDeviceId: DeviceId;
  let roomId: string;

  beforeAll(async () => {
    driver = new FakeRawCapableAvr();
    const registry = new EntityRegistryMirror();
    const router = new RoutingBackendAdapter({
      ha: new MockAdapter(),
      native: new SupremeNativeAdapter({ drivers: [driver] }),
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

    const homeRes = await fetch(`${baseUrl}/v1/home`, { headers: auth() });
    roomId = ((await homeRes.json()) as { rooms: { id: string }[] }).rooms[0]!.id;
    const devRes = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ backendId: "192.168.1.81", name: "Media Room AVR", roomId, capabilities: ["media"] }),
    });
    rawDeviceId = ((await devRes.json()) as { device: { id: DeviceId } }).device.id;
    const bindRes = await fetch(`${baseUrl}/v1/commissioning/bind`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ deviceId: rawDeviceId, capability: "media", protocol: "avr", address: "192.168.1.81" }),
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

  it("writes the raw token to the owning native driver and returns ok:true", async () => {
    const res = await fetch(`${baseUrl}/v1/devices/${rawDeviceId}/raw-command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ token: "PSCINEMA EQ.ON" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(driver.rawCalls).toContainEqual({ deviceId: rawDeviceId, token: "PSCINEMA EQ.ON" });
  });

  it("rejects an empty token with 422 (schema validation, never reaches the driver)", async () => {
    const before = driver.rawCalls.length;
    const res = await fetch(`${baseUrl}/v1/devices/${rawDeviceId}/raw-command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ token: "" }),
    });
    expect(res.status).toBe(422);
    expect(driver.rawCalls.length).toBe(before);
  });

  it("404s for a device that doesn't exist", async () => {
    const res = await fetch(`${baseUrl}/v1/devices/device-nope/raw-command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ token: "PW?" }),
    });
    expect(res.status).toBe(404);
  });

  it("422s (validation_failed) for a device whose backend doesn't support raw commands (HA-owned)", async () => {
    const homeRes = await fetch(`${baseUrl}/v1/home`, { headers: auth() });
    const room2 = ((await homeRes.json()) as { rooms: { id: string }[] }).rooms[0]!.id;
    const haDevRes = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ backendId: "ha-light-1", name: "HA Light", roomId: room2, capabilities: ["onoff"] }),
    });
    const haDeviceId = ((await haDevRes.json()) as { device: { id: DeviceId } }).device.id;
    await fetch(`${baseUrl}/v1/commissioning/bind`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ deviceId: haDeviceId, capability: "onoff", protocol: "ha", address: "ha-light-1" }),
    });

    const res = await fetch(`${baseUrl}/v1/devices/${haDeviceId}/raw-command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ token: "PW?" }),
    });
    expect(res.status).toBe(422);
  });
});
