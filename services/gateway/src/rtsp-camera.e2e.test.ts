import type { CameraList } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import net from "node:net";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  // ── UniFi Protect mode: a REAL self-signed https server standing in for the console and a real
  // RTSP listener for the stream, exercised through the real routes. (Nothing here proves it works
  // against genuine UniFi hardware — the console's endpoint shapes are unverified.)
  describe("UniFi Protect mode", () => {
    const API_KEY = "unifi-secret-key-xyz";
    let console_: https.Server;
    let consolePort = 0;
    let cameraA: { port: number; close: () => Promise<void> };
    let certDir: string;
    const seenKeys: string[] = [];
    let postCount = 0;

    beforeAll(async () => {
      cameraA = await startFakeRtspServer({});
      certDir = mkdtempSync(path.join(tmpdir(), "unifi-e2e-"));
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(certDir, "k.pem"), "-out", path.join(certDir, "c.pem"), "-days", "1", "-subj", "/CN=console"]);
      console_ = https.createServer({ key: readFileSync(path.join(certDir, "k.pem")), cert: readFileSync(path.join(certDir, "c.pem")) }, (req, res) => {
        seenKeys.push(String(req.headers["x-api-key"]));
        res.setHeader("content-type", "application/json");
        if (req.headers["x-api-key"] !== API_KEY) {
          res.statusCode = 401;
          res.end("{}");
          return;
        }
        if (req.url === "/proxy/protect/integration/v1/cameras") {
          res.end(JSON.stringify([{ id: "uc1", name: "Driveway", state: "CONNECTED", marketName: "G5 Bullet" }, { id: "uc2", name: "Garage" }]));
          return;
        }
        const m = req.url?.match(/^\/proxy\/protect\/integration\/v1\/cameras\/(\w+)\/rtsps-stream$/);
        if (m) {
          if (req.method === "POST" && m[1] === "uc1") postCount++;
          if (m[1] === "uc2") {
            res.statusCode = 404;
            res.end("{}");
            return;
          }
          res.end(JSON.stringify({ high: `rtsp://127.0.0.1:${cameraA.port}/tokenHIGH`, low: `rtsp://127.0.0.1:${cameraA.port}/tokenLOW` }));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
      await new Promise<void>((r) => console_.listen(0, "127.0.0.1", r));
      consolePort = (console_.address() as { port: number }).port;
    });
    afterAll(async () => {
      await new Promise<void>((r) => console_.close(() => r()));
      await cameraA.close();
      rmSync(certDir, { recursive: true, force: true });
    });

    const post = (p: string, body: unknown) => fetch(`${baseUrl}${p}`, { method: "POST", headers: auth(), body: JSON.stringify(body) });

    it("lists cameras (id/name/model/state only) and never echoes the API key", async () => {
      const res = await post("/v1/drivers/rtsp/unifi/cameras", { host: `127.0.0.1:${consolePort}`, apiKey: API_KEY });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(API_KEY);
      const { cameras } = JSON.parse(text) as { cameras: { id: string; model: string | null }[] };
      expect(cameras.map((c) => c.id)).toEqual(["uc1", "uc2"]);
      expect(cameras[0]!.model).toBe("G5 Bullet");
    });

    it("gives a plain-English error for a wrong API key and rejects a public console host", async () => {
      const bad = await post("/v1/drivers/rtsp/unifi/cameras", { host: `127.0.0.1:${consolePort}`, apiKey: "nope" });
      expect(bad.status).toBe(422);
      expect(((await bad.json()) as { message: string }).message).toMatch(/API key/);
      const pub = await post("/v1/drivers/rtsp/unifi/cameras", { host: "8.8.8.8", apiKey: API_KEY });
      expect(pub.status).toBe(422);
      expect(((await pub.json()) as { message: string }).message).toMatch(/local-network/);
    });

    it("commissions selected cameras, isolates a failing one, and is idempotent on re-run", async () => {
      const body = {
        host: `127.0.0.1:${consolePort}`,
        apiKey: API_KEY,
        cameras: [{ id: "uc1", name: "Driveway", model: "G5 Bullet" }, { id: "uc2", name: "Garage" }],
      };
      const before = ((await (await fetch(`${baseUrl}/v1/cameras`, { headers: auth() })).json()) as CameraList).cameras.length;
      const r1 = await post("/v1/drivers/rtsp/unifi/commission", body);
      expect(r1.status).toBe(200);
      const t1 = await r1.text();
      expect(t1).not.toContain(API_KEY);
      expect(t1).not.toContain("tokenHIGH");
      const res1 = (JSON.parse(t1) as { results: { status: string }[] }).results;
      expect(res1.map((r) => r.status)).toEqual(["added", "failed"]);

      const r2 = await post("/v1/drivers/rtsp/unifi/commission", body);
      const res2 = ((await r2.json()) as { results: { status: string }[] }).results;
      expect(res2.map((r) => r.status)).toEqual(["already-added", "failed"]);

      const after = ((await (await fetch(`${baseUrl}/v1/cameras`, { headers: auth() })).json()) as CameraList).cameras;
      expect(after.length).toBe(before + 1); // exactly one new device despite two commissions
      const cam = after.find((c) => c.name === "Driveway")!;
      expect(cam.streamUrl).toBe(`rtsp://127.0.0.1:${cameraA.port}/tokenHIGH`);
      expect(postCount).toBe(0); // existing streams are read, never re-created
      // The API key is never persisted: not in any driver config.
      const instances = await ctx.installer.drivers.listInstances("supreme-rtsp-camera");
      expect(JSON.stringify(instances)).not.toContain(API_KEY);
    });
  });
});
