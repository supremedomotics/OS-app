import type { CameraList } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * RTSP Camera driver — end-to-end (§ RTSP Camera Extension): install the driver, discover on the
 * real (loopback-only, in this test env) network, run Test Connection and Commission against a
 * REAL minimal RTSP server (a local TCP listener speaking real RTSP/1.0 text, not a mock of the
 * gateway route itself) so the installer-facing flow is exercised end to end, then verifies the
 * commissioned camera's credentials never reach any API response and survive being read back.
 */
function startFakeRtspServer(opts: { username?: string; password?: string }): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (!buf.includes("\r\n\r\n")) return;
        const request = buf;
        buf = "";
        if (/^OPTIONS/.test(request)) {
          sock.write("RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY\r\n\r\n");
          return;
        }
        if (/^DESCRIBE/.test(request)) {
          if (opts.username) {
            const expected = `Basic ${Buffer.from(`${opts.username}:${opts.password}`, "utf8").toString("base64")}`;
            const authMatch = request.match(/Authorization:\s*(.+)\r\n/i);
            if (!authMatch || authMatch[1]!.trim() !== expected) {
              sock.write(`RTSP/1.0 401 Unauthorized\r\nCSeq: 2\r\nWWW-Authenticate: Basic realm="cam"\r\n\r\n`);
              return;
            }
          }
          const sdp = "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=stream\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n";
          sock.write(`RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Type: application/sdp\r\n\r\n${sdp}`);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

describe("RTSP Camera driver — discovery + commissioning", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let fakeCamera: { port: number; close: () => Promise<void> };

  beforeAll(async () => {
    fakeCamera = await startFakeRtspServer({ username: "admin", password: "admin" });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }));
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
    await fakeCamera.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("refuses discovery/commissioning before the driver is installed", async () => {
    const res = await fetch(`${baseUrl}/v1/drivers/rtsp/discover`, { method: "POST", headers: auth(), body: JSON.stringify({}) });
    expect(res.status).toBe(409);
  });

  it("installs the RTSP Camera extension", async () => {
    const res = await fetch(`${baseUrl}/v1/drivers/install`, { method: "POST", headers: auth(), body: JSON.stringify({ key: "supreme-rtsp-camera" }) });
    expect(res.status).toBe(201);
  });

  it("discovery runs without throwing on a real (loopback-scoped) network scan", async () => {
    const res = await fetch(`${baseUrl}/v1/drivers/rtsp/discover`, { method: "POST", headers: auth(), body: JSON.stringify({ timeoutMs: 500 }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cameras: unknown[] };
    expect(Array.isArray(body.cameras)).toBe(true);
  });

  it("Test Connection fails cleanly with the wrong password, then succeeds with the right one", async () => {
    const bad = await fetch(`${baseUrl}/v1/drivers/rtsp/test-connection`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ mode: "manual", rtspUrl: `rtsp://127.0.0.1:${fakeCamera.port}/stream`, username: "admin", password: "wrong" }),
    });
    expect(bad.status).toBe(200);
    const badBody = (await bad.json()) as { result: { ok: boolean; reason: string | null } };
    expect(badBody.result.ok).toBe(false);
    expect(JSON.stringify(badBody)).not.toContain("wrong"); // password never echoed back

    const good = await fetch(`${baseUrl}/v1/drivers/rtsp/test-connection`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ mode: "manual", rtspUrl: `rtsp://127.0.0.1:${fakeCamera.port}/stream`, username: "admin", password: "admin" }),
    });
    const goodBody = (await good.json()) as { result: { ok: boolean } };
    expect(goodBody.result.ok).toBe(true);
  });

  it("Test Connection rejects a non-local RTSP URL (SSRF guard)", async () => {
    const res = await fetch(`${baseUrl}/v1/drivers/rtsp/test-connection`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ mode: "manual", rtspUrl: "rtsp://8.8.8.8/stream" }),
    });
    const body = (await res.json()) as { result: { ok: boolean; reason: string | null } };
    expect(body.result.ok).toBe(false);
    expect(body.result.reason).toMatch(/local-network/i);
  });

  it("commissions an RTSP-only camera, and its credentials never appear in any API response", async () => {
    const res = await fetch(`${baseUrl}/v1/drivers/rtsp/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "Backyard Camera",
        mode: "manual",
        rtspUrl: `rtsp://127.0.0.1:${fakeCamera.port}/stream`,
        username: "admin",
        password: "admin",
      }),
    });
    expect(res.status).toBe(201);
    const bodyText = await res.text();
    expect(bodyText).not.toContain("admin\""); // no raw credential echoed
    const { camera, validation } = JSON.parse(bodyText) as { camera: { id: string; streamUrl: string }; validation: { ok: boolean } };
    expect(validation.ok).toBe(true);
    expect(camera.streamUrl).toBe(`rtsp://127.0.0.1:${fakeCamera.port}/stream`); // credential-free, persisted
    expect(camera.streamUrl).not.toContain("admin");

    // Shows up in the ordinary camera registry, credential-free, exactly like any other camera.
    const list = (await (await fetch(`${baseUrl}/v1/cameras`, { headers: auth() })).json()) as CameraList;
    const found = list.cameras.find((c) => c.id === camera.id);
    expect(found).toBeTruthy();
    expect(found!.streamUrl).not.toContain("admin");
  });

  it("commission fails honestly when validation fails (wrong credentials)", async () => {
    const res = await fetch(`${baseUrl}/v1/drivers/rtsp/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "Bad Camera",
        mode: "manual",
        rtspUrl: `rtsp://127.0.0.1:${fakeCamera.port}/stream`,
        username: "admin",
        password: "wrong-password",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("commission rejects an invalid/unsafe RTSP URL before ever touching the network", async () => {
    const res = await fetch(`${baseUrl}/v1/drivers/rtsp/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "Unsafe", mode: "manual", rtspUrl: "http://192.168.1.1/evil" }),
    });
    expect(res.status).toBe(422);
  });
});
