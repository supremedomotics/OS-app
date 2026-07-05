import {
  MatterProtocolDriver,
  type MatterAddress,
  type MatterAttributeReport,
  type MatterController,
  type MatterNodeInfo,
  type MatterOnboardingPayload,
} from "@supreme/protocols";
import {
  EntityRegistryMirror,
  MockAdapter,
  RoutingBackendAdapter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
} from "@supreme/integration-layer";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Matter routes end-to-end: with a (faked) on-box controller, an installer pairs a device by its
 * setup code over /v1/matter/commission and it is registered as a Supreme device + bound to the
 * Matter protocol. Only the hardware controller (PASE/CASE) is faked — the route, code parsing,
 * commissioning seam, and device registration are exercised for real.
 */
class FakeController implements MatterController {
  commissioned: MatterOnboardingPayload[] = [];
  async connect() {}
  async disconnect() {}
  async invoke(_a: MatterAddress, _c: string, _cmd: string, _f: Record<string, unknown>) {}
  subscribe(_a: MatterAddress, _h: (r: MatterAttributeReport) => void) {}
  async nodes(): Promise<MatterNodeInfo[]> {
    return [];
  }
  async commission(p: MatterOnboardingPayload): Promise<MatterNodeInfo> {
    this.commissioned.push(p);
    return { nodeId: "9", endpoint: 1, clusters: ["OnOff"], vendor: "Acme", product: "Smart Plug" };
  }
}

describe("Matter commissioning routes", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let roomId = "";
  const driver = new MatterProtocolDriver({ createController: async () => new FakeController() });

  beforeAll(async () => {
    await driver.connect();
    // Mirror production wiring: the Matter driver lives in the SIL's native adapter AND is exposed
    // as the matter handle (same instance), so commissioning binds the protocol for real.
    const registry = new EntityRegistryMirror();
    const sil = new SupremeIntegrationLayer({
      adapter: new RoutingBackendAdapter({ ha: new MockAdapter(), native: new SupremeNativeAdapter({ drivers: [driver] }), registry }),
      registry,
    });
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      matter: { driver, fabric: null },
    });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    token = ((await login.json()) as { accessToken: string }).accessToken;
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string }[] };
    roomId = home.rooms[0]!.id;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });
  function auth() {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  it("reports Matter status: enabled + controller connected", async () => {
    const res = await fetch(`${baseUrl}/v1/matter/status`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, connected: true, fabricId: null, nodeCount: 0 });
  });

  it("commissions a device from the canonical manual setup code", async () => {
    const res = await fetch(`${baseUrl}/v1/matter/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ setupCode: "3497-011-2332", roomId, name: "Patio Plug" }),
    });
    expect(res.status).toBe(201);
    const { device } = (await res.json()) as { device: { name: string; roomId: string; capabilities: { kind: string }[] } };
    expect(device.name).toBe("Patio Plug");
    expect(device.roomId).toBe(roomId);
    expect(device.capabilities.map((c) => c.kind)).toContain("onoff");
  });

  it("rejects an invalid setup code", async () => {
    const res = await fetch(`${baseUrl}/v1/matter/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ setupCode: "0000-000-0000", roomId }),
    });
    expect(res.status).toBe(422); // validation_failed
  });
});

describe("Matter routes when disabled (ships disabled per blueprint §9)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" })); // no matter handle
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    token = ((await login.json()) as { accessToken: string }).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  it("reports Matter disabled", async () => {
    const res = await fetch(`${baseUrl}/v1/matter/status`, { headers: { authorization: `Bearer ${token}` } });
    expect(await res.json()).toMatchObject({ enabled: false, connected: false });
  });

  it("returns 409 to a commission attempt when Matter is not enabled", async () => {
    const res = await fetch(`${baseUrl}/v1/matter/commission`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ setupCode: "3497-011-2332", roomId: "room-anything" }),
    });
    expect(res.status).toBe(409);
  });
});
