import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Scene schedules end-to-end: store a schedule + the home location, then drive the scheduler at the
 * trigger minute and assert the scene activates. Validation is enforced on write.
 */
describe("Scene schedule routes + scheduler", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let sceneId = "";

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }) })
    ).json()) as { accessToken: string };
    token = login.accessToken;
    // Create a scene to schedule.
    const created = (await (
      await fetch(`${baseUrl}/v1/scenes`, { method: "POST", headers: auth(), body: JSON.stringify({ name: "Evening", scope: "home", steps: [] }) })
    ).json()) as { scene: { id: string } };
    sceneId = created.scene.id;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });
  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("stores schedules and rejects malformed ones (422)", async () => {
    const bad = await fetch(`${baseUrl}/v1/scenes/schedules`, { method: "PUT", headers: auth(), body: JSON.stringify({ schedules: [{ sceneId, trigger: { type: "time", atMinutes: 9999 } }] }) });
    expect(bad.status).toBe(422);

    const ok = await fetch(`${baseUrl}/v1/scenes/schedules`, { method: "PUT", headers: auth(), body: JSON.stringify({ schedules: [{ sceneId, trigger: { type: "time", atMinutes: 7 * 60 } }] }) });
    expect(ok.status).toBe(200);
    const got = await (await fetch(`${baseUrl}/v1/scenes/schedules`, { headers: auth() })).json();
    expect(got.schedules).toHaveLength(1);
    expect(got.schedules[0].id).toBeTruthy();
  });

  it("the scheduler activates the scheduled scene at its trigger minute", async () => {
    // A schedule for 07:00 is stored above. Drive the scheduler with the clock at 07:00.
    // The scheduler reads the stored schedules from the home config.
    let activated = false;
    const origActivate = ctx.scenes.activate.bind(ctx.scenes);
    (ctx.scenes as unknown as { activate: typeof ctx.scenes.activate }).activate = async (id) => {
      if (id === sceneId) activated = true;
      return origActivate(id);
    };
    // Construct a scheduler bound to this context's config + the patched activate, at 07:00.
    const { SceneScheduler } = await import("./scene-scheduler.js");
    const scheduler = new SceneScheduler({
      getSchedules: async () => ((await ctx.homeConfig.get(ctx.homeId, "scene_schedules")) as never[]) ?? [],
      getLocation: async () => undefined,
      activate: (id) => ctx.scenes.activate(id as never).then(() => undefined),
      now: () => new Date(2026, 0, 5, 7, 0, 0),
    });
    await scheduler.tick();
    expect(activated).toBe(true);
  });

  it("stores the home location (for solar schedules)", async () => {
    const res = await fetch(`${baseUrl}/v1/home/location`, { method: "PUT", headers: auth(), body: JSON.stringify({ lat: 40.7, lon: -74 }) });
    expect(res.status).toBe(200);
    expect((await res.json()).location.lat).toBe(40.7);
  });
});
