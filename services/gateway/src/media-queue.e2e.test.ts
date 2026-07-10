import type { DeviceList, LoginResponse, MediaQueueResponse } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * GET /v1/devices/:id/media/queue (§ Universal AVR Framework — media integration).
 * Exercises the route wiring end-to-end over the mock backend: auth, device lookup,
 * and the honest "no queue" fallback for backends (the mock adapter; classic Denon
 * Telnet / Yamaha in real deployments) that don't implement a real play queue.
 */
describe("GET /v1/devices/:id/media/queue", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let deviceId = "";

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
      })
    ).json()) as LoginResponse;
    if (login.status !== "ok") throw new Error("expected tokens");
    token = login.accessToken;

    const list = (await (
      await fetch(`${baseUrl}/v1/devices`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as DeviceList;
    deviceId = list.devices[0]?.id ?? "";
    expect(deviceId).not.toBe("");
  });

  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  it("requires authentication", async () => {
    const res = await fetch(`${baseUrl}/v1/devices/${deviceId}/media/queue`);
    expect(res.status).toBe(401);
  });

  it("404s for a device that doesn't exist", async () => {
    const res = await fetch(`${baseUrl}/v1/devices/device-does-not-exist/media/queue`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("returns an empty (not fabricated) queue for a backend with no real queue concept", async () => {
    const res = await fetch(`${baseUrl}/v1/devices/${deviceId}/media/queue`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MediaQueueResponse;
    expect(body).toEqual({ items: [] });
  });
});
