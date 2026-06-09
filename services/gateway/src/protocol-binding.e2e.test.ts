import type { HomeView, ProtocolBindingList } from "@supreme/contracts";
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
  bindingKey,
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

/** Minimal fake bus driver — records command writes and can push state up. */
class FakeBusDriver implements INativeProtocolDriver {
  readonly protocol = "fake";
  readonly writes: Array<{ deviceId: DeviceId; command: CapabilityCommand }> = [];
  private connected = false;
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  isConnected() {
    return this.connected;
  }
  async bind(b: ProtocolBinding) {
    this.devices.add(b.deviceId);
  }
  manages(d: DeviceId) {
    return this.devices.has(d);
  }
  async command(deviceId: DeviceId, command: CapabilityCommand) {
    this.writes.push({ deviceId, command });
    const state: CapabilityState = { kind: "onoff", on: command.capability === "onoff" && (command as { action: string }).action !== "off" };
    this.states.set(bindingKey(deviceId, command.capability), state);
    for (const l of this.listeners) l({ deviceId, capability: command.capability, state, ts: new Date().toISOString() });
  }
  getState(deviceId: DeviceId, capability: CapabilityKind) {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }
  async discover(): Promise<DiscoveredDevice[]> {
    return [];
  }
  onState(l: StateListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/**
 * End-to-end native protocol binding (§3): commission a device, bind one of its
 * capabilities to a real bus driver via the API, and prove subsequent commands route
 * to that driver — with the binding persisted and listable.
 */
describe("Native protocol binding e2e", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  const driver = new FakeBusDriver();
  const bindingStore = new InMemoryProtocolBindingStore();

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const native = new SupremeNativeAdapter({ drivers: [driver] });
    const router = new RoutingBackendAdapter({
      ha: new MockAdapter(),
      native,
      registry,
      policy: new MigrationPolicy(),
    });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore: bindingStore,
    });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

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

  it("binds a commissioned device to a bus and routes commands to its driver", async () => {
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const roomId = home.rooms[0]!.id;

    // Commission a plain on/off device.
    const commissioned = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        backendId: "fake.relay.1",
        name: "Plant Room Relay",
        roomId,
        capabilities: ["onoff"],
      }),
    });
    expect(commissioned.status).toBe(201);
    const deviceId = ((await commissioned.json()) as { device: { id: string } }).device.id;

    // Bind it to the fake bus driver.
    const bound = await fetch(`${baseUrl}/v1/commissioning/bind`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        deviceId,
        capability: "onoff",
        protocol: "fake",
        address: "bus/relay/1",
      }),
    });
    expect(bound.status).toBe(201);

    // It is listed + persisted.
    const list = (await (
      await fetch(`${baseUrl}/v1/commissioning/bindings`, { headers: auth() })
    ).json()) as ProtocolBindingList;
    expect(list.bindings.some((b) => b.deviceId === deviceId)).toBe(true);
    expect(await bindingStore.list()).toHaveLength(1);

    // Commanding the device now flows over the bound driver, not HA/mock.
    const cmd = await fetch(`${baseUrl}/v1/devices/${deviceId}/command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ command: { capability: "onoff", action: "on" } }),
    });
    expect(cmd.status).toBe(200);
    expect(driver.writes).toHaveLength(1);
    expect(driver.writes[0]?.deviceId).toBe(deviceId);
  });
});
