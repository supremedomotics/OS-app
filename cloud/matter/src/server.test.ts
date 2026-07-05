import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildMatterServer } from "./server.js";

/**
 * Cloud Matter HTTP API: a hub ensures its fabric (idempotent), records commissioned nodes, and
 * adds co-admins for multi-admin — all scoped to the hub's own home by its API key.
 */
describe("Cloud Matter HTTP API", () => {
  let app: FastifyInstance;
  const auth = (key: string) => ({ authorization: `Bearer ${key}` });

  beforeAll(async () => {
    app = buildMatterServer({ apiKeys: new Map([["hub-a-key", "home-a"], ["hub-b-key", "home-b"]]), logLevel: "silent" });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("rejects requests without a valid API key", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/matter/fabrics" });
    expect(res.statusCode).toBe(401);
  });

  it("ensures a fabric idempotently (same fabric on repeat)", async () => {
    const r1 = await app.inject({ method: "POST", url: "/v1/matter/fabrics", headers: auth("hub-a-key") });
    const r2 = await app.inject({ method: "POST", url: "/v1/matter/fabrics", headers: auth("hub-a-key") });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().fabric.fabricId).toBe(r2.json().fabric.fabricId);
    expect(r1.json().admins[0].label).toBe("Supreme Hub");
  });

  it("records nodes and lists them, scoped to the fabric", async () => {
    const fabricId = (await app.inject({ method: "POST", url: "/v1/matter/fabrics", headers: auth("hub-a-key") })).json().fabric.fabricId;
    const node = await app.inject({ method: "POST", url: `/v1/matter/fabrics/${fabricId}/nodes`, headers: auth("hub-a-key"), payload: { nodeId: "42", vendorId: 0xfff1, productId: 0x8000 } });
    expect(node.statusCode).toBe(201);
    expect(node.json().node.nocRef).toMatch(/^noc-/);
    const list = await app.inject({ method: "GET", url: `/v1/matter/fabrics/${fabricId}/nodes`, headers: auth("hub-a-key") });
    expect(list.json().nodes).toHaveLength(1);
  });

  it("adds a co-admin for multi-admin sharing", async () => {
    const fabricId = (await app.inject({ method: "POST", url: "/v1/matter/fabrics", headers: auth("hub-a-key") })).json().fabric.fabricId;
    const res = await app.inject({ method: "POST", url: `/v1/matter/fabrics/${fabricId}/admins`, headers: auth("hub-a-key"), payload: { adminNodeId: "0x2", label: "Apple Home" } });
    expect(res.statusCode).toBe(201);
    const admins = (await app.inject({ method: "GET", url: `/v1/matter/fabrics/${fabricId}/admins`, headers: auth("hub-a-key") })).json().admins;
    expect(admins.map((a: { label: string }) => a.label)).toEqual(["Supreme Hub", "Apple Home"]);
  });

  it("forbids touching another home's fabric", async () => {
    const fabricId = (await app.inject({ method: "POST", url: "/v1/matter/fabrics", headers: auth("hub-a-key") })).json().fabric.fabricId;
    // hub-b tries to add a node to home-a's fabric → 404 (not visible to it).
    const res = await app.inject({ method: "POST", url: `/v1/matter/fabrics/${fabricId}/nodes`, headers: auth("hub-b-key"), payload: { nodeId: "99" } });
    expect(res.statusCode).toBe(404);
  });

  it("validates required fields", async () => {
    const fabricId = (await app.inject({ method: "POST", url: "/v1/matter/fabrics", headers: auth("hub-a-key") })).json().fabric.fabricId;
    const res = await app.inject({ method: "POST", url: `/v1/matter/fabrics/${fabricId}/nodes`, headers: auth("hub-a-key"), payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
