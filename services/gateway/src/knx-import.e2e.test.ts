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

/** A no-op KNX driver so the import's native bindings succeed in-process. */
class FakeKnx implements INativeProtocolDriver {
  readonly protocol = "knx";
  private readonly devices = new Set<DeviceId>();
  private readonly listeners = new Set<StateListener>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(_id: DeviceId, _c: CapabilityCommand): Promise<void> {}
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> { return []; }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

/**
 * ETS group-address import (§4): an installer uploads a KNX group-address export and the
 * hub auto-creates device cards — capabilities inferred from the DPTs, placed into their
 * rooms (existing matched by name, new ones created), each capability bound to its KNX
 * group address. No live discovery needed.
 */
describe("KNX ETS import → device cards", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";

  const EXPORT = `<GroupAddress-Export>
    <GroupAddress Name="Living Room - Reading Lamp - Switch" Address="1/2/1" DPTs="DPST-1-1" />
    <GroupAddress Name="Living Room - Reading Lamp - Brightness" Address="1/2/2" DPTs="DPST-5-1" />
    <GroupAddress Name="Living Room - Reading Lamp - Status" Address="1/2/3" DPTs="DPST-1-1" />
    <GroupAddress Name="Garage - Ceiling Light - Switch" Address="4/1/1" DPTs="DPST-1-1" />
    <GroupAddress Name="Garage - Shutter - Position" Address="4/2/1" DPTs="DPST-5-1" />
  </GroupAddress-Export>`;

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const router = new RoutingBackendAdapter({
      ha: new MockAdapter(),
      native: new SupremeNativeAdapter({ drivers: [new FakeKnx()] }),
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

  it("imports the export, creating cards in existing + new rooms with inferred capabilities", async () => {
    const res = await fetch(`${baseUrl}/v1/commissioning/import/knx`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ content: EXPORT }),
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { devices: number; roomsCreated: number; created: { name: string; room: string | null; capabilities: string[] }[] };
    expect(out.devices).toBe(3); // Reading Lamp, Ceiling Light, Shutter
    expect(out.roomsCreated).toBe(1); // Garage (Living Room already exists)

    const lamp = out.created.find((d) => d.name.includes("Reading Lamp"));
    expect(lamp?.room).toBe("Living Room");
    expect(new Set(lamp?.capabilities)).toEqual(new Set(["onoff", "brightness"])); // Status (1-bit) deduped

    // The new "Garage" room now exists with its imported devices.
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string; name: string }[] };
    const garage = home.rooms.find((r) => r.name === "Garage");
    expect(garage).toBeTruthy();
    const devices = (await (await fetch(`${baseUrl}/v1/rooms/${garage!.id}/devices`, { headers: auth() })).json()) as { devices: { name: string; capabilities: { kind: string }[] }[] };
    const shutter = devices.devices.find((d) => d.name.includes("Shutter"));
    expect(shutter?.capabilities.map((c) => c.kind)).toContain("position");
  });

  const TUNABLE_WHITE_EXPORT = `<GroupAddress-Export>
    <GroupAddress Name="Study - Downlight - Switch" Address="5/1/1" DPTs="DPST-1-1" />
    <GroupAddress Name="Study - Downlight - Brightness" Address="5/1/2" DPTs="DPST-5-1" />
    <GroupAddress Name="Study - Downlight - Colour Temperature" Address="5/1/3" DPTs="DPST-7-600" />
    <GroupAddress Name="Pantry - Utility Switch" Address="5/2/1" DPTs="DPST-1-1" />
  </GroupAddress-Export>`;

  it("previews without committing, then saves only the installer-included/edited devices", async () => {
    const preview = await fetch(`${baseUrl}/v1/commissioning/import/knx/preview`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ content: TUNABLE_WHITE_EXPORT }),
    });
    expect(preview.status).toBe(200);
    const previewOut = (await preview.json()) as {
      devices: { name: string; room: string | null; deviceType: string; bindings: { capability: string; address: string }[] }[];
      warnings: { code: string; message: string }[];
      stats: { groupAddressCount: number; recognizedDeviceCount: number };
    };
    expect(previewOut.devices).toHaveLength(2);
    expect(previewOut.stats.groupAddressCount).toBe(4);
    const downlight = previewOut.devices.find((d) => d.name.includes("Downlight"))!;
    expect(downlight.deviceType).toBe("light_tunable_white");
    expect(new Set(downlight.bindings.map((b) => b.capability))).toEqual(new Set(["onoff", "brightness", "color"]));
    const utility = previewOut.devices.find((d) => d.name.includes("Utility"))!;
    expect(utility.deviceType).toBe("light_switch");

    // A preview must not create anything — neither room exists yet.
    const beforeHome = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { name: string }[] };
    expect(beforeHome.rooms.some((r) => r.name === "Study" || r.name === "Reading Nook" || r.name === "Pantry")).toBe(false);

    // The installer excludes "Utility Switch" and re-rooms the downlight before saving.
    const commit = await fetch(`${baseUrl}/v1/commissioning/import/knx/commit`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        devices: [
          { ...downlight, room: "Reading Nook", included: true },
          { ...utility, included: false },
        ],
      }),
    });
    expect(commit.status).toBe(201);
    const commitOut = (await commit.json()) as { devices: number; roomsCreated: number; created: { name: string; room: string | null }[] };
    expect(commitOut.devices).toBe(1);
    expect(commitOut.roomsCreated).toBe(1);
    expect(commitOut.created[0]?.room).toBe("Reading Nook");

    const afterHome = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string; name: string }[] };
    expect(afterHome.rooms.some((r) => r.name === "Pantry")).toBe(false); // excluded device's room was never created
    const nook = afterHome.rooms.find((r) => r.name === "Reading Nook");
    expect(nook).toBeTruthy();
    const nookDevices = (await (await fetch(`${baseUrl}/v1/rooms/${nook!.id}/devices`, { headers: auth() })).json()) as {
      devices: { name: string; capabilities: { kind: string }[] }[];
    };
    expect(new Set(nookDevices.devices[0]?.capabilities.map((c) => c.kind))).toEqual(new Set(["onoff", "brightness", "color"]));
  });
});
