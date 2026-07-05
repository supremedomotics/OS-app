import type { CameraList, CameraResponse, CameraStreamResponse } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Camera streaming done right (§11.1): register a view-only camera with an RTSP source,
 * then resolve it into client-playable HLS/WebRTC URLs via the hub's stream engine — a
 * client never receives a raw rtsp:// it can't open.
 */
describe("Cameras + RTSP streaming", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    ctx = await AppContext.create(
      loadConfig({
        SUPREME_LOG_LEVEL: "silent",
        SUPREME_STREAM_BASE_URL: "https://hub.local/stream",
        SUPREME_STREAM_ENGINE: "go2rtc",
      }),
    );
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

  it("registers a camera, lists it, and resolves playable streams from its RTSP source", async () => {
    const reg = await fetch(`${baseUrl}/v1/cameras`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "Front Door",
        streamUrl: "rtsp://10.0.0.5:554/h264",
        snapshotUrl: "http://10.0.0.5/snap.jpg",
      }),
    });
    expect(reg.status).toBe(201);
    const { camera } = (await reg.json()) as CameraResponse;
    expect(camera.streamUrl).toBe("rtsp://10.0.0.5:554/h264");

    // It shows in the camera registry with its source.
    const list = (await (await fetch(`${baseUrl}/v1/cameras`, { headers: auth() })).json()) as CameraList;
    expect(list.cameras.find((c) => c.id === camera.id)?.snapshotUrl).toBe("http://10.0.0.5/snap.jpg");

    // The RTSP source resolves to client-playable HLS + WebRTC (plus the raw rtsp).
    const streamRes = await fetch(`${baseUrl}/v1/cameras/${camera.id}/stream`, { headers: auth() });
    expect(streamRes.status).toBe(200);
    const { streams } = (await streamRes.json()) as CameraStreamResponse;
    const hls = streams.find((s) => s.kind === "hls");
    expect(hls?.url).toBe(`https://hub.local/stream/api/stream.m3u8?src=${camera.id}`);
    expect(streams.find((s) => s.kind === "webrtc")).toBeTruthy();
    expect(streams.find((s) => s.kind === "rtsp")?.url).toBe("rtsp://10.0.0.5:554/h264");
  });

  it("rejects streaming a camera with no source configured", async () => {
    const reg = await fetch(`${baseUrl}/v1/cameras`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "Unconfigured Cam" }),
    });
    const { camera } = (await reg.json()) as CameraResponse;
    const res = await fetch(`${baseUrl}/v1/cameras/${camera.id}/stream`, { headers: auth() });
    expect(res.status).toBe(422); // validation_failed → 422

    // After setting a source, it streams.
    await fetch(`${baseUrl}/v1/cameras/${camera.id}/source`, {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ streamUrl: "rtsp://10.0.0.9/stream" }),
    });
    const ok = await fetch(`${baseUrl}/v1/cameras/${camera.id}/stream`, { headers: auth() });
    expect(ok.status).toBe(200);
  });
});
