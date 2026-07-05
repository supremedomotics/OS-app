import type { HomeView, SceneResponse, ServerFrame } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Phase-1 Homeowner MVP coverage: scenes, favorites, user management + grants,
 * and live notifications — all over the Supreme contract through the full stack.
 */
describe("Phase-1 homeowner MVP", () => {
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

  async function login(email = "owner@supreme.local", password = "supreme-owner-demo-pass") {
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json()) as { status: string; accessToken?: string };
    if (body.status !== "ok") throw new Error("expected tokens");
    return body.accessToken!;
  }

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async function firstLivingRoomDevice(token: string): Promise<string> {
    const home = (await (
      await fetch(`${baseUrl}/v1/home`, { headers: auth(token) })
    ).json()) as HomeView;
    const living = home.rooms.find((r) => r.name === "Living Room")!;
    const devices = (await (
      await fetch(`${baseUrl}/v1/rooms/${living.id}/devices`, { headers: auth(token) })
    ).json()) as { devices: { id: string; supremeType: string }[] };
    return devices.devices.find((d) => d.supremeType === "dimmer")!.id;
  }

  it("creates, activates a scene, and the activation drives device state over WSS", async () => {
    const token = await login();
    const deviceId = await firstLivingRoomDevice(token);

    const created = (await (
      await fetch(`${baseUrl}/v1/scenes`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          name: "Movie Night",
          scope: "home",
          steps: [{ deviceId, capability: "brightness", values: { action: "set", level: 15 } }],
        }),
      })
    ).json()) as SceneResponse;
    expect(created.scene.name).toBe("Movie Night");

    // Subscribe to all rooms, then activate.
    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${token}`);
    await new Promise((r) => ws.once("open", r));
    const state = new Promise<ServerFrame>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no state delta")), 4000);
      ws.on("message", (raw: Buffer) => {
        const f = JSON.parse(raw.toString()) as ServerFrame;
        if (f.type === "state" && f.deviceId === deviceId) {
          clearTimeout(t);
          resolve(f);
        }
      });
    });
    ws.send(JSON.stringify({ type: "subscribe", rooms: ["*"] }));

    const activate = await fetch(`${baseUrl}/v1/scenes/${created.scene.id}/activate`, {
      method: "POST",
      headers: auth(token),
    });
    const activation = (await activate.json()) as { activated: boolean; steps: number };
    expect(activation.steps).toBe(1);

    const frame = await state;
    if (frame.type !== "state") throw new Error("unreachable");
    expect(frame.state).toEqual({ kind: "brightness", on: true, level: 15 });
    ws.close();
  });

  it("adds and lists favorites", async () => {
    const token = await login();
    const deviceId = await firstLivingRoomDevice(token);
    const res = await fetch(`${baseUrl}/v1/favorites`, {
      method: "PUT",
      headers: auth(token),
      body: JSON.stringify({ ref: { type: "device", deviceId }, favorite: true }),
    });
    const body = (await res.json()) as { favorites: unknown[] };
    expect(body.favorites.length).toBeGreaterThan(0);
  });

  it("master creates a family user who is denied user-management but can control devices", async () => {
    const token = await login();
    const created = await fetch(`${baseUrl}/v1/users`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        email: "family@supreme.local",
        password: "family-demo-password",
        displayName: "Family Member",
        userType: "family",
      }),
    });
    expect(created.status).toBe(201);

    const familyToken = await login("family@supreme.local", "family-demo-password");

    // Family cannot list users (no baseline user:view).
    const listUsers = await fetch(`${baseUrl}/v1/users`, { headers: auth(familyToken) });
    expect(listUsers.status).toBe(403);

    // But family CAN control a device.
    const deviceId = await firstLivingRoomDevice(familyToken);
    const cmd = await fetch(`${baseUrl}/v1/devices/${deviceId}/command`, {
      method: "POST",
      headers: auth(familyToken),
      body: JSON.stringify({ command: { capability: "onoff", action: "on" } }),
    });
    expect(cmd.status).toBe(200);
  });

  it("delivers a hub-generated notification over WSS and via REST history", async () => {
    const token = await login();
    const home = await ctx.home.getHome();

    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${token}`);
    await new Promise((r) => ws.once("open", r));
    const got = new Promise<ServerFrame>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no notification")), 4000);
      ws.on("message", (raw: Buffer) => {
        const f = JSON.parse(raw.toString()) as ServerFrame;
        if (f.type === "notification") {
          clearTimeout(t);
          resolve(f);
        }
      });
    });

    // Simulate a hub-internal event (e.g. a device went offline).
    await ctx.notifications.create({
      homeId: home!.id,
      level: "warning",
      title: "Front Door",
      body: "Battery low",
    });

    const frame = await got;
    if (frame.type !== "notification") throw new Error("unreachable");
    expect(frame.title).toBe("Front Door");

    const history = (await (
      await fetch(`${baseUrl}/v1/notifications`, { headers: auth(token) })
    ).json()) as { notifications: { title: string }[] };
    expect(history.notifications.some((n) => n.title === "Front Door")).toBe(true);
    ws.close();
  });

  it("the owner can add, rename, and list rooms", async () => {
    const token = await login();
    const created = await fetch(`${baseUrl}/v1/rooms`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ name: "  Home Gym  ", areaType: "utility", floor: 1 }),
    });
    expect(created.status).toBe(201);
    const room = ((await created.json()) as { room: { id: string; name: string; areaType: string; floor: number } }).room;
    expect(room.name).toBe("Home Gym"); // trimmed
    expect(room.areaType).toBe("utility");

    // It now shows up in the home topology.
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth(token) })).json()) as HomeView;
    expect(home.rooms.some((r) => r.id === room.id && r.name === "Home Gym")).toBe(true);

    // Rename it.
    const renamed = await fetch(`${baseUrl}/v1/rooms/${room.id}`, { method: "PATCH", headers: auth(token), body: JSON.stringify({ name: "Gym" }) });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { room: { name: string } }).room.name).toBe("Gym");

    // An empty name is rejected.
    const bad = await fetch(`${baseUrl}/v1/rooms`, { method: "POST", headers: auth(token), body: JSON.stringify({ name: "   " }) });
    expect(bad.status).toBe(422);
  });
});
