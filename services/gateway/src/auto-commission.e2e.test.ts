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
 * A fake Casambi-style native driver: discovery advertises two luminaires, each tagged with its
 * bus "room" (a Casambi group name), and records the commands it receives so we can prove control
 * reaches the bus after auto-commissioning.
 */
class FakeCasambi implements INativeProtocolDriver {
  readonly protocol = "casambi";
  readonly commands: { id: DeviceId; command: CapabilityCommand }[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly listeners = new Set<StateListener>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(id: DeviceId, command: CapabilityCommand): Promise<void> {
    this.commands.push({ id, command });
    if (command.capability === "brightness") {
      const state: CapabilityState = { kind: "brightness", on: true, level: command.level ?? 100 };
      for (const l of this.listeners) l({ deviceId: id, capability: "brightness", state, ts: new Date().toISOString() });
    }
  }
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> {
    return [
      { backendId: "casambi:45", suggestedName: "Gallery Pendant", capabilities: ["brightness", "color"], raw: { room: "Gallery" } },
      { backendId: "casambi:46", suggestedName: "Studio Lamp", capabilities: ["onoff"], raw: { room: "Studio" } },
    ];
  }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

describe("Auto-commission a live native bus (Casambi) → rooms + control", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let driver: FakeCasambi;

  beforeAll(async () => {
    driver = new FakeCasambi();
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
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("discovers, creates rooms from group names, commissions + binds, and routes control to the bus", async () => {
    const res = await fetch(`${baseUrl}/v1/commissioning/auto`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ protocol: "casambi" }),
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { devices: number; roomsCreated: number; created: { name: string; room: string | null; capabilities: string[] }[] };
    expect(out.devices).toBe(2);

    const pendant = out.created.find((d) => d.name === "Gallery Pendant");
    expect(pendant?.room).toBe("Gallery");
    expect(new Set(pendant?.capabilities)).toEqual(new Set(["brightness", "color"]));

    // "Studio" was created from the Casambi group name and holds the Studio Lamp.
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string; name: string }[] };
    const studio = home.rooms.find((r) => r.name === "Studio");
    expect(studio).toBeTruthy();
    const studioDevices = (await (await fetch(`${baseUrl}/v1/rooms/${studio!.id}/devices`, { headers: auth() })).json()) as { devices: { id: string; name: string }[] };
    expect(studioDevices.devices.find((d) => d.name === "Studio Lamp")).toBeTruthy();

    // Control the Gallery pendant — the command must reach the Casambi bus.
    const gallery = home.rooms.find((r) => r.name === "Gallery")!;
    const galleryDevices = (await (await fetch(`${baseUrl}/v1/rooms/${gallery.id}/devices`, { headers: auth() })).json()) as { devices: { id: string; name: string }[] };
    const pendantId = galleryDevices.devices.find((d) => d.name === "Gallery Pendant")!.id;
    const cmd = await fetch(`${baseUrl}/v1/devices/${pendantId}/command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ command: { capability: "brightness", action: "set", level: 40 } }),
    });
    expect(cmd.status).toBeLessThan(300);
    expect(driver.commands.at(-1)).toMatchObject({ command: { capability: "brightness", level: 40 } });
  });
});
