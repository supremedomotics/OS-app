import { issueMobileAuthorizationToken } from "@supreme/hub-identity";
import type { Device, HomeView, LoginResponse, SceneRun, ServerFrame } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Phase 3 — Hub-orchestrated Experience activation and Hub-served assets, against a REAL running
 * gateway (HTTP + WSS + SIL + state feed), authorized the way a paired Mobile is.
 */
describe("Hub-orchestrated Experiences and Hub-served assets (real gateway)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let base: string;
  let wsBase: string;
  let mobile: string;
  let owner: string;

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
    ctx.mobileAuthorizations.upsert({
      mobileId: "m1", publicKeyBase64: "pk", hubId: ctx.hubIdentity.hubUuid, projectId: ctx.homeId,
      label: "Test Mobile", pairedAt: new Date().toISOString(), lastSeenAt: null, revoked: false, revokedAt: null,
    });
    mobile = issueMobileAuthorizationToken(ctx.hubIdentity, { mobileId: "m1", hubId: ctx.hubIdentity.hubUuid, projectId: ctx.homeId });
    const res = await fetch(`${base}/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    const body = (await res.json()) as LoginResponse;
    if (body.status !== "ok") throw new Error("login");
    owner = body.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  const j = (token: string, extra: RequestInit = {}): RequestInit => ({
    ...extra,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(extra.headers ?? {}) },
  });

  async function dimmersInTwoRooms(): Promise<Device[]> {
    const { devices } = (await (await fetch(`${base}/v1/devices`, j(mobile))).json()) as { devices: Device[] };
    const dims = devices.filter((d) => d.roomId && d.capabilities.some((c) => c.kind === "brightness" || c.kind === "onoff"));
    const byRoom = new Map<string, Device>();
    for (const d of dims) if (!byRoom.has(d.roomId!)) byRoom.set(d.roomId!, d);
    const two = [...byRoom.values()].slice(0, 2);
    expect(two.length).toBe(2);
    return two;
  }

  /** A verifiable step for whatever the device can do: dim it, or switch it on. */
  const stepFor = (d: Device, level: number) =>
    d.capabilities.some((c) => c.kind === "brightness")
      ? { deviceId: d.id, capability: "brightness", values: { action: "set", level } }
      : { deviceId: d.id, capability: "onoff", values: { action: "on" } };

  async function createScene(devs: Device[], level: number): Promise<{ id: string }> {
    const res = await fetch(`${base}/v1/scenes`, j(owner, {
      method: "POST",
      body: JSON.stringify({
        name: "Test Experience", scope: "home", roomId: null, icon: null,
        steps: devs.map((d) => stepFor(d, level)),
        description: "Soft light in two rooms",
      }),
    }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { scene: { id: string } }).scene;
  }

  /** Collects `run` frames for a run until a terminal snapshot arrives. */
  function watch(runFilter: () => string | null): { ready: Promise<void>; terminal: Promise<SceneRun>; frames: SceneRun[]; close(): void } {
    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${encodeURIComponent(mobile)}`);
    const frames: SceneRun[] = [];
    const ready = new Promise<void>((r) => ws.on("open", () => { ws.send(JSON.stringify({ type: "subscribe", rooms: ["*"] })); setTimeout(r, 50); }));
    const terminal = new Promise<SceneRun>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no terminal run frame; saw ${frames.length}`)), 8000);
      ws.on("message", (raw: Buffer) => {
        const f = JSON.parse(raw.toString()) as ServerFrame;
        if (f.type !== "run") return;
        frames.push(f.run);
        const id = runFilter();
        if ((id === null || f.run.runId === id) && f.run.status !== "running") { clearTimeout(t); resolve(f.run); }
      });
    });
    return { ready, terminal, frames, close: () => ws.close() };
  }

  it("lists scenes with the spaces they act in, and their authored line", async () => {
    const devs = await dimmersInTwoRooms();
    const scene = await createScene(devs, 35);
    const { scenes } = (await (await fetch(`${base}/v1/scenes`, j(mobile))).json()) as { scenes: { id: string; roomIds: string[]; description: string | null; phases: number[][] }[] };
    const mine = scenes.find((s) => s.id === scene.id)!;
    expect(new Set(mine.roomIds)).toEqual(new Set(devs.map((d) => d.roomId)));
    expect(mine.description).toBe("Soft light in two rooms");
    expect(mine.phases).toEqual([]);
  });

  it("activation returns a run at once, streams it, and concludes only from device reports", async () => {
    const devs = await dimmersInTwoRooms();
    const scene = await createScene(devs, 35);
    let runId: string | null = null;
    const w = watch(() => runId);
    await w.ready;

    const res = await fetch(`${base}/v1/scenes/${scene.id}/activate`, j(mobile, { method: "POST", body: "{}" }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { activated: boolean; steps: number; run: SceneRun };
    runId = body.run.runId;
    expect(body.run.status).toBe("running");
    expect(body.run.steps).toHaveLength(2);
    expect(body.run.steps.every((s) => s.verifiable)).toBe(true);
    expect(body.steps).toBe(2);

    const done = await w.terminal;
    w.close();
    expect(done.status).toBe("completed");
    expect(done.steps.map((s) => s.state)).toEqual(["confirmed", "confirmed"]);
    // The verdict is the DEVICES': their state, read back over REST, is what was asked.
    const { devices: now } = (await (await fetch(`${base}/v1/devices`, j(mobile))).json()) as { devices: Device[] };
    for (const d of devs) {
      const st = now.find((x) => x.id === d.id)!.state as Record<string, { level?: number; on?: boolean }>;
      if (d.capabilities.some((c) => c.kind === "brightness")) expect(st.brightness!.level).toBe(35);
      else expect(st.onoff!.on).toBe(true);
    }
    // Frames were snapshots of one run, in order, ending terminal.
    expect(w.frames.map((f) => f.runId).every((id) => id === runId)).toBe(true);
    // And the run can be read back by id (it outlives the request).
    const again = (await (await fetch(`${base}/v1/scenes/runs/${runId}`, j(mobile))).json()) as { run: SceneRun };
    expect(again.run.status).toBe("completed");
  });

  it("a scoped activation acts only in the spaces asked for", async () => {
    const devs = await dimmersInTwoRooms();
    const scene = await createScene(devs, 20);
    const res = await fetch(`${base}/v1/scenes/${scene.id}/activate`, j(mobile, { method: "POST", body: JSON.stringify({ spaceIds: [devs[1]!.roomId] }) }));
    const { run } = (await res.json()) as { run: SceneRun };
    expect(run.spaceIds).toEqual([devs[1]!.roomId]);
    expect(run.steps.map((s) => s.deviceId)).toEqual([devs[1]!.id]);
  });

  it("an unknown run is 404 and a bad token is 401", async () => {
    expect((await fetch(`${base}/v1/scenes/runs/nope`, j(mobile))).status).toBe(404);
    expect((await fetch(`${base}/v1/scenes/runs/nope`, { headers: { authorization: "Bearer junk" } })).status).toBe(401);
  });

  describe("assets (ADR 0102)", () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

    it("the residence photograph: owner uploads, a paired Mobile reads it with ETag and a versioned URL", async () => {
      const before = (await (await fetch(`${base}/v1/home`, j(mobile))).json()) as HomeView;
      expect(before.home.heroImageUrl).toBeNull();
      expect((await fetch(`${base}/v1/home/hero-image`, j(mobile))).status).toBe(404);

      const put = await fetch(`${base}/v1/home/hero-image`, j(owner, { method: "PUT", body: JSON.stringify({ dataBase64: png, contentType: "image/png" }) }));
      expect(put.status).toBe(200);
      const { heroImageUrl } = (await put.json()) as { heroImageUrl: string };
      expect(heroImageUrl).toMatch(/^\/v1\/home\/hero-image\?v=[0-9a-f]{32}$/);

      const home = (await (await fetch(`${base}/v1/home`, j(mobile))).json()) as HomeView;
      expect(home.home.heroImageUrl).toBe(heroImageUrl);

      const res = await fetch(`${base}${heroImageUrl}`, { headers: { authorization: `Bearer ${mobile}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const etag = res.headers.get("etag")!;
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
      expect(Buffer.from(await res.arrayBuffer()).toString("base64")).toBe(png);

      const cached = await fetch(`${base}${heroImageUrl}`, { headers: { authorization: `Bearer ${mobile}`, "if-none-match": etag } });
      expect(cached.status).toBe(304);
    });

    it("a room photograph is served to a paired Mobile too, and its URL changes when the picture does", async () => {
      const home = (await (await fetch(`${base}/v1/home`, j(mobile))).json()) as HomeView;
      const room = home.rooms[0]!;
      const a = await fetch(`${base}/v1/rooms/${room.id}/hero-image`, j(owner, { method: "PUT", body: JSON.stringify({ dataBase64: png, contentType: "image/png" }) }));
      const urlA = ((await a.json()) as { room: { heroImageUrl: string } }).room.heroImageUrl;
      const png2 = Buffer.from("89504e470d0a1a0a0000000d49484453", "hex").toString("base64");
      const b = await fetch(`${base}/v1/rooms/${room.id}/hero-image`, j(owner, { method: "PUT", body: JSON.stringify({ dataBase64: png2, contentType: "image/png" }) }));
      const urlB = ((await b.json()) as { room: { heroImageUrl: string } }).room.heroImageUrl;
      expect(urlA).not.toBe(urlB);
      const res = await fetch(`${base}${urlB}`, { headers: { authorization: `Bearer ${mobile}` } });
      expect(res.status).toBe(200);
    });

    it("no credential, no picture", async () => {
      expect((await fetch(`${base}/v1/home/hero-image`)).status).toBe(401);
      expect((await fetch(`${base}/v1/home/hero-image`, { headers: { authorization: "Bearer junk" } })).status).toBe(401);
    });
  });
});
