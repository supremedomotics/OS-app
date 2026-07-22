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
 * A fake AVR-shaped native driver whose reported AudioCapabilityConfig genuinely
 * changes between the first `getCapabilityConfig()` call (at bind time) and a
 * subsequent one after `refreshCapabilities()` runs — proving the new
 * POST /v1/devices/:id/capabilities/refresh route (§ Capability Refresh) actually
 * re-queries and persists fresh data, not just replays the original commission-time
 * snapshot.
 */
class FakeRefreshableAvr implements INativeProtocolDriver {
  readonly protocol = "avr";
  readonly refreshCalls: DeviceId[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly listeners = new Set<StateListener>();
  /** Flips after the first refreshCapabilities() call — simulates a real device that
   * genuinely reports a different capability set once re-queried (e.g. an installer
   * enabled Zone 2 on the physical unit, or firmware added an input). */
  private refreshed = false;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(): Promise<void> {}
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> {
    return [{ backendId: "192.168.1.80", suggestedName: "Living Room AVR", capabilities: ["onoff", "media"], raw: { protocol: "avr" } }];
  }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  getCapabilityConfig(_deviceId: DeviceId, capability: CapabilityKind): Record<string, unknown> | null {
    if (capability !== "media") return null;
    return {
      source: "installer_declared",
      inputs: this.refreshed
        ? [{ id: "BD", label: "Blu-ray", type: "hdmi" }, { id: "GAME", label: "Game", type: "hdmi" }]
        : [{ id: "BD", label: "Blu-ray", type: "hdmi" }],
    };
  }
  async refreshCapabilities(deviceId: DeviceId): Promise<void> {
    this.refreshCalls.push(deviceId);
    this.refreshed = true;
  }
}

describe("Capability Refresh (§ Part 2): POST /v1/devices/:id/capabilities/refresh", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let driver: FakeRefreshableAvr;
  let deviceId: DeviceId;
  let roomId: string;

  beforeAll(async () => {
    driver = new FakeRefreshableAvr();
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

    // Commission a room + device, then bind it to the fake driver (mirrors
    // installer-context.bindProtocol's own real commission→bind flow).
    const homeRes = await fetch(`${baseUrl}/v1/home`, { headers: auth() });
    roomId = ((await homeRes.json()) as { rooms: { id: string }[] }).rooms[0]!.id;
    const devRes = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ backendId: "192.168.1.80", name: "Living Room AVR", roomId, capabilities: ["media"] }),
    });
    deviceId = ((await devRes.json()) as { device: { id: DeviceId } }).device.id;
    const bindRes = await fetch(`${baseUrl}/v1/commissioning/bind`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ deviceId, capability: "media", protocol: "avr", address: "192.168.1.80" }),
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

  type RoomDevice = { id: string; roomId: string; capabilities: { kind: string; config: Record<string, unknown> }[] };
  async function fetchDevice(): Promise<RoomDevice> {
    const res = await fetch(`${baseUrl}/v1/rooms/${roomId}/devices`, { headers: auth() });
    const { devices } = (await res.json()) as { devices: RoomDevice[] };
    return devices.find((d) => d.id === deviceId)!;
  }

  it("persists the ORIGINAL capability config at bind time (one input)", async () => {
    const device = await fetchDevice();
    const media = device.capabilities.find((c) => c.kind === "media")!;
    expect((media.config.inputs as unknown[]).length).toBe(1);
  });

  it("re-queries the driver and persists the FRESH capability config — device is never recreated (same id, room, capabilities)", async () => {
    const before = await fetchDevice();

    const res = await fetch(`${baseUrl}/v1/devices/${deviceId}/capabilities/refresh`, { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refreshed: boolean; config: { inputs: unknown[] } | null };
    expect(body.refreshed).toBe(true);
    expect(body.config?.inputs).toHaveLength(2); // now includes "Game"
    expect(driver.refreshCalls).toContain(deviceId);

    const after = await fetchDevice();
    expect(after.id).toBe(before.id); // same device — not recreated
    expect(after.roomId).toBe(before.roomId); // room assignment untouched
    const media = after.capabilities.find((c) => c.kind === "media")!;
    expect((media.config.inputs as unknown[]).length).toBe(2); // persisted, not just returned
  });

  it("reports refreshed:false when the config genuinely didn't change (honest, not an error — matches Denon/Marantz Telnet's real behavior)", async () => {
    // The fake driver already flipped to its "refreshed" config state in the previous
    // test — calling refresh again re-queries and gets back the SAME config, which is
    // exactly what a protocol with no live capability query does every time.
    const res = await fetch(`${baseUrl}/v1/devices/${deviceId}/capabilities/refresh`, { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refreshed: boolean };
    expect(body.refreshed).toBe(false);
  });

  it("404s for a device that doesn't exist", async () => {
    const res = await fetch(`${baseUrl}/v1/devices/device-nope/capabilities/refresh`, { method: "POST", headers: auth() });
    expect(res.status).toBe(404);
  });
});
