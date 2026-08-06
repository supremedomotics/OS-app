import type { CapabilityKind, CapabilityState, DeviceId, DriverDiagnosticsSnapshot } from "@supreme/domain-model";
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

/** A driver whose reported connection status the test controls directly, so
 * reconciliation can be driven through real connect/drop/reconnect transitions
 * without needing real hardware. */
class ToggleableDriver implements INativeProtocolDriver {
  readonly protocol = "toggleable";
  connectionStatus: DriverDiagnosticsSnapshot["connectionStatus"] = "connected";
  private readonly devices = new Set<DeviceId>();
  private readonly listeners = new Set<StateListener>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(): Promise<void> {}
  getState(): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> {
    return [{ backendId: "toggleable:1", suggestedName: "Toggleable Sensor", capabilities: ["onoff"], raw: {} }];
  }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  getDiagnostics(id: DeviceId): DriverDiagnosticsSnapshot | null {
    if (!this.devices.has(id)) return null;
    return {
      connectionStatus: this.connectionStatus, protocol: this.protocol, driverVersion: "test", model: null, firmware: null,
      serial: null, ip: null, mac: null, lastCommand: null, lastCommandAt: null, lastResponse: null, lastResponseAt: null,
      responseTimeMs: null, averageLatencyMs: null, packetsSent: 0, packetsReceived: 0, reconnectCount: 0, lastError: null,
      fullySynced: true,
    };
  }
}

/** A driver with NO per-device diagnostics at all — reconciliation must fall back
 * to the protocol-level connectivity signal instead. */
class NoDiagnosticsDriver implements INativeProtocolDriver {
  readonly protocol = "no-diag";
  private connected = true;
  private readonly devices = new Set<DeviceId>();
  private readonly listeners = new Set<StateListener>();
  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  isConnected(): boolean { return this.connected; }
  async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(): Promise<void> {}
  getState(): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> {
    return [{ backendId: "no-diag:1", suggestedName: "No-Diagnostics Sensor", capabilities: ["onoff"], raw: {} }];
  }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

describe("§ Native Backend Implementation — Device.status reconciliation", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let toggleable: ToggleableDriver;
  let noDiag: NoDiagnosticsDriver;

  beforeAll(async () => {
    toggleable = new ToggleableDriver();
    noDiag = new NoDiagnosticsDriver();
    const registry = new EntityRegistryMirror();
    const router = new RoutingBackendAdapter({
      ha: new MockAdapter(),
      native: new SupremeNativeAdapter({ drivers: [toggleable, noDiag] }),
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

  async function commission(protocol: string, backendId: string, name: string): Promise<DeviceId> {
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string }[] };
    const res = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ backendId, name, roomId: home.rooms[0]!.id, capabilities: ["onoff" as CapabilityKind], protocol }),
    });
    expect(res.status).toBeLessThan(300);
    const { device } = (await res.json()) as { device: { id: DeviceId } };
    return device.id;
  }

  async function statusOf(deviceId: DeviceId): Promise<string> {
    const res = await fetch(`${baseUrl}/v1/devices`, { headers: auth() });
    const { devices } = (await res.json()) as { devices: { id: DeviceId; status: string }[] };
    return devices.find((d) => d.id === deviceId)!.status;
  }

  it("reflects the owning driver's real per-device connectionStatus, both ways", async () => {
    const deviceId = await commission("toggleable", "toggleable:1", "Toggleable Sensor");
    expect(await statusOf(deviceId)).toBe("online"); // commissioning default, unchanged until reconciled

    toggleable.connectionStatus = "disconnected";
    await ctx.installer.reconcileDeviceStatuses();
    expect(await statusOf(deviceId)).toBe("offline");

    toggleable.connectionStatus = "connected";
    await ctx.installer.reconcileDeviceStatuses();
    expect(await statusOf(deviceId)).toBe("online");
  });

  it("falls back to the owning protocol's connect/disconnect status when the driver reports no per-device diagnostics", async () => {
    const deviceId = await commission("no-diag", "no-diag:1", "No-Diagnostics Sensor");
    expect(await statusOf(deviceId)).toBe("online");

    await noDiag.disconnect();
    await ctx.installer.reconcileDeviceStatuses();
    expect(await statusOf(deviceId)).toBe("offline");

    await noDiag.connect();
    await ctx.installer.reconcileDeviceStatuses();
    expect(await statusOf(deviceId)).toBe("online");
  });

  it("never touches an HA-owned or unassigned device's status — no signal to act on, never fabricated", async () => {
    // The seeded demo home's devices are native-owned but never bound to any of
    // THIS test's drivers — reconcileDeviceStatuses must leave them alone (still
    // "online", exactly as commissioned) rather than guessing.
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as {
      rooms: { id: string; name: string }[];
    };
    const living = home.rooms.find((r) => r.name === "Living Room")!;
    const devices = (await (await fetch(`${baseUrl}/v1/rooms/${living.id}/devices`, { headers: auth() })).json()) as {
      devices: { id: DeviceId; status: string }[];
    };
    expect(devices.devices.length).toBeGreaterThan(0);
    await ctx.installer.reconcileDeviceStatuses();
    for (const d of devices.devices) expect(await statusOf(d.id)).toBe("online");
  });
});
