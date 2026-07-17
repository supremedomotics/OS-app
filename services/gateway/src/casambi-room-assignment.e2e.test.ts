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
 * Casambi Automatic Room Assignment (§ Universal Room Intelligence — Priority 4).
 *
 * Exercises the ACTUAL path the Discover Devices UI drives — POST /v1/commissioning/
 * discover then POST /v1/commissioning/commission — which `auto-commission.e2e.test.ts`
 * does NOT cover (that file only exercises the separate, UI-unreachable
 * /v1/commissioning/auto endpoint). This is the gap that let the room-hint-dropping bug
 * ship unnoticed: the tested path worked, the actually-used path didn't propagate a
 * driver's room hint at all.
 */
class FakeCasambi implements INativeProtocolDriver {
  readonly protocol = "casambi";
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
    return [
      { backendId: "casambi:1", suggestedName: "R&D Study Lights", capabilities: ["brightness"], raw: { room: "R&D" } },
      { backendId: "casambi:2", suggestedName: "R&D Downlight", capabilities: ["brightness"], raw: { room: "R&D" } },
      { backendId: "casambi:3", suggestedName: "Kitchen Spot", capabilities: ["onoff"], raw: { room: "Kitchen" } },
    ];
  }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

describe("Casambi Automatic Room Assignment via the actual Discover Devices UI path", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const router = new RoutingBackendAdapter({
      ha: new MockAdapter(),
      native: new SupremeNativeAdapter({ drivers: [new FakeCasambi()] }),
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

  it("discovery response carries the driver's room hint (roomHint), not silently dropped", async () => {
    // No `protocol` filter — matches the real Discover Devices UI's client.discover()
    // call exactly (apps/web-homeowner/src/discover.tsx). Passing a protocol here would
    // route through the Python-tooling scanner map instead of sil.discover(), which is
    // NOT where a native bus driver like Casambi is registered.
    const res = await fetch(`${baseUrl}/v1/commissioning/discover`, { method: "POST", headers: auth(), body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    const { discovered } = (await res.json()) as { discovered: Array<{ backendId: string; roomHint?: string | null }> };
    const study = discovered.find((d) => d.backendId === "casambi:1");
    expect(study?.roomHint).toBe("R&D");
  });

  it("commissioning with no roomId, only roomNameHint, creates the matching room automatically", async () => {
    const before = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string; name: string }[] };
    expect(before.rooms.some((r) => r.name === "R&D")).toBe(false);

    const res = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ backendId: "casambi:1", name: "R&D Study Lights", roomNameHint: "R&D", capabilities: ["brightness"] }),
    });
    expect(res.status).toBe(201);

    const after = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string; name: string }[] };
    const rd = after.rooms.find((r) => r.name === "R&D");
    expect(rd).toBeTruthy();
    const devices = (await (await fetch(`${baseUrl}/v1/rooms/${rd!.id}/devices`, { headers: auth() })).json()) as { devices: { name: string }[] };
    expect(devices.devices.some((d) => d.name === "R&D Study Lights")).toBe(true);
  });

  it("a second device with the same group hint reuses the room instead of creating a duplicate", async () => {
    const before = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string; name: string }[] };
    const rdCountBefore = before.rooms.filter((r) => r.name === "R&D").length;
    expect(rdCountBefore).toBe(1);

    const res = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ backendId: "casambi:2", name: "R&D Downlight", roomNameHint: "R&D", capabilities: ["brightness"] }),
    });
    expect(res.status).toBe(201);

    const after = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string; name: string }[] };
    expect(after.rooms.filter((r) => r.name === "R&D").length).toBe(1); // no duplicate room
    const rd = after.rooms.find((r) => r.name === "R&D")!;
    const devices = (await (await fetch(`${baseUrl}/v1/rooms/${rd.id}/devices`, { headers: auth() })).json()) as { devices: { name: string }[] };
    expect(devices.devices.map((d) => d.name).sort()).toEqual(["R&D Downlight", "R&D Study Lights"]);
  });

  it("room-name matching is punctuation/case-insensitive without merging different rooms (§ Room Normalization)", async () => {
    // "r&d" (lowercase, same punctuation) must resolve to the SAME room as "R&D" above.
    const res1 = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST", headers: auth(),
      body: JSON.stringify({ backendId: "casambi:1b", name: "R&D Extra Light", roomNameHint: "r&d", capabilities: ["onoff"] }),
    });
    expect(res1.status).toBe(201);
    // "R & D" (spaced) must ALSO resolve to the same room.
    const res2 = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST", headers: auth(),
      body: JSON.stringify({ backendId: "casambi:1c", name: "R&D Extra Light 2", roomNameHint: "R & D", capabilities: ["onoff"] }),
    });
    expect(res2.status).toBe(201);

    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string; name: string }[] };
    expect(home.rooms.filter((r) => r.name === "R&D").length).toBe(1); // still just one room

    // A genuinely different name must NOT be merged in.
    const res3 = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST", headers: auth(),
      body: JSON.stringify({ backendId: "casambi:3", name: "Kitchen Spot", roomNameHint: "Kitchen", capabilities: ["onoff"] }),
    });
    expect(res3.status).toBe(201);
    const home2 = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string; name: string }[] };
    expect(home2.rooms.some((r) => r.name === "Kitchen")).toBe(true);
    expect(home2.rooms.filter((r) => r.name === "R&D").length).toBe(1); // Kitchen didn't merge into R&D
  });

  it("an explicit roomId override always wins over roomNameHint (priority 1)", async () => {
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string; name: string }[] };
    const kitchen = home.rooms.find((r) => r.name === "Kitchen")!;

    const res = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST", headers: auth(),
      body: JSON.stringify({ backendId: "casambi:override", name: "Explicitly Placed", roomId: kitchen.id, roomNameHint: "R&D", capabilities: ["onoff"] }),
    });
    expect(res.status).toBe(201);

    const devices = (await (await fetch(`${baseUrl}/v1/rooms/${kitchen.id}/devices`, { headers: auth() })).json()) as { devices: { name: string }[] };
    expect(devices.devices.some((d) => d.name === "Explicitly Placed")).toBe(true); // landed in Kitchen (explicit), not R&D (hint)
  });
});
