import type { HomeView, LoginResponse, ServerFrame } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Phase-0 exit proof (§16, §19): tap a light through the FULL Supreme stack —
 * Client → Gateway → (authz) → SIL → backend adapter → normalized state delta
 * back over WSS — with zero HA leakage in the contract. Uses the mock backend so
 * it runs anywhere with no HA or hardware.
 */
describe("Phase-0 end-to-end: tap a light through the full stack", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let wsBase: string;

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  async function login(): Promise<string> {
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LoginResponse;
    expect(body.status).toBe("ok");
    if (body.status !== "ok") throw new Error("expected tokens");
    return body.accessToken;
  }

  it("rejects unauthenticated control", async () => {
    const res = await fetch(`${baseUrl}/v1/home`);
    expect(res.status).toBe(401);
  });

  it("logs in, lists rooms/devices, and never exposes HA identifiers", async () => {
    const token = await login();
    const homeRes = await fetch(`${baseUrl}/v1/home`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const home = (await homeRes.json()) as HomeView;
    expect(home.rooms.length).toBeGreaterThan(0);

    const room = home.rooms[0]!;
    const devRes = await fetch(`${baseUrl}/v1/rooms/${room.id}/devices`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const devices = (await devRes.json()) as { devices: { id: string }[] };
    expect(devices.devices.length).toBeGreaterThan(0);

    // The serialized contract must contain no HA entity ids (e.g. "light.living_room").
    const serialized = JSON.stringify(devices);
    expect(serialized).not.toMatch(/light\./);
    expect(serialized.toLowerCase()).not.toContain("homeassistant");
  });

  it("taps a light over REST and receives a normalized state delta over WSS", async () => {
    const token = await login();

    // Find the living-room dimmer.
    const home = (await (
      await fetch(`${baseUrl}/v1/home`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as HomeView;
    const living = home.rooms.find((r) => r.name === "Living Room")!;
    const devices = (await (
      await fetch(`${baseUrl}/v1/rooms/${living.id}/devices`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { devices: { id: string }[] };
    const deviceId = devices.devices[0]!.id;

    // Open the stream and subscribe to the living room.
    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${token}`);
    const stateFrame = new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no state delta received")), 4000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", rooms: [living.id] })));
      ws.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as ServerFrame;
        if (frame.type === "state") {
          clearTimeout(timer);
          resolve(frame);
        }
      });
      ws.on("error", reject);
    });
    await new Promise((r) => ws.once("open", r));

    // Tap: set brightness to 60% via the core control verb.
    const cmdRes = await fetch(`${baseUrl}/v1/devices/${deviceId}/command`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ command: { capability: "brightness", action: "set", level: 60 } }),
    });
    expect(cmdRes.status).toBe(200);

    const frame = await stateFrame;
    expect(frame.type).toBe("state");
    if (frame.type !== "state") throw new Error("unreachable");
    expect(frame.deviceId).toBe(deviceId);
    expect(frame.state).toEqual({ kind: "brightness", on: true, level: 60 });
    ws.close();
  });

  it("accepts a command frame over WSS and acks it", async () => {
    const token = await login();
    const home = (await (
      await fetch(`${baseUrl}/v1/home`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as HomeView;
    const kitchen = home.rooms.find((r) => r.name === "Kitchen")!;
    const devices = (await (
      await fetch(`${baseUrl}/v1/rooms/${kitchen.id}/devices`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { devices: { id: string }[] };
    const deviceId = devices.devices[0]!.id;

    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${token}`);
    await new Promise((r) => ws.once("open", r));
    const ack = new Promise<ServerFrame>((resolve) => {
      ws.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as ServerFrame;
        if (frame.type === "ack") resolve(frame);
      });
    });
    ws.send(
      JSON.stringify({
        type: "command",
        requestId: "req-1",
        deviceId,
        command: { capability: "onoff", action: "on" },
      }),
    );
    const frame = await ack;
    if (frame.type !== "ack") throw new Error("expected ack");
    expect(frame.accepted).toBe(true);
    expect(frame.requestId).toBe("req-1");
    ws.close();
  });
});
