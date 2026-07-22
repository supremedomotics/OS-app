import { newId, type DeviceId, type HomeId } from "@supreme/domain-model";
import { MockAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { AutomationEngine } from "@supreme/automations";
import { describe, expect, it } from "vitest";
import { SceneService } from "./scene-service.js";

async function setup() {
  const adapter = new MockAdapter();
  const sil = new SupremeIntegrationLayer({ adapter });
  await sil.start();
  const deviceId = newId("device") as DeviceId;
  sil.mapEntity(deviceId, "brightness", { backendId: "light.x", backendDomain: "light" });
  sil.mapEntity(deviceId, "onoff", { backendId: "light.x", backendDomain: "light" });
  return { sil, deviceId, scenes: new SceneService(sil) };
}

async function setupWithEngine() {
  const base = await setup();
  const engine = new AutomationEngine({
    executors: {
      command: (deviceId, command) => base.sil.command(deviceId, command),
      activateScene: async () => {},
      notify: async () => {},
      getState: (deviceId, capability) => base.sil.getState(deviceId, capability),
    },
  });
  base.scenes.attachEngine(engine);
  return { ...base, engine };
}

describe("SceneService", () => {
  it("creates, lists, and activates a scene via capability commands", async () => {
    const { sil, deviceId, scenes } = await setup();
    const scene = await scenes.create({
      homeId: newId("home") as HomeId,
      name: "Movie",
      scope: "room",
      steps: [
        { deviceId, capability: "brightness", values: { action: "set", level: 20 } },
      ],
    });
    expect(scene.name).toBe("Movie");
    expect((await scenes.list())).toHaveLength(1);

    const dispatched = await scenes.activate(scene.id);
    expect(dispatched).toBe(1);
    const state = await sil.getState(deviceId, "brightness");
    expect(state).toEqual({ kind: "brightness", on: true, level: 20 });
  });

  it("skips invalid steps but dispatches valid ones", async () => {
    const { deviceId, scenes } = await setup();
    const scene = await scenes.create({
      homeId: newId("home") as HomeId,
      name: "Mixed",
      steps: [
        { deviceId, capability: "onoff", values: { action: "on" } },
        { deviceId, capability: "brightness", values: { action: "set", level: 999 } }, // invalid
      ],
    });
    expect(await scenes.activate(scene.id)).toBe(1);
  });

  it("404s on unknown scene", async () => {
    const { scenes } = await setup();
    await expect(scenes.get(newId("scene") as never)).rejects.toThrow(/not found/);
  });

  it("§ ADR 0101 Part 1 — when an engine is attached, activation routes through it and records a real run", async () => {
    const { sil, deviceId, scenes } = await setupWithEngine();
    const scene = await scenes.create({
      homeId: newId("home") as HomeId,
      name: "Evening",
      steps: [{ deviceId, capability: "onoff", values: { action: "on" } }],
    });

    expect(await scenes.activate(scene.id)).toBe(1);
    expect((await sil.getState(deviceId, "onoff"))).toEqual({ kind: "onoff", on: true });

    const runs = scenes.recentRuns(scene.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);

    const health = await scenes.health(scene.id);
    expect(health?.status).toBe("healthy");
  });

  it("§ ADR 0101 Part 1 — engine-routed activation is still best-effort: one bad step doesn't block the rest", async () => {
    const { deviceId, scenes } = await setupWithEngine();
    const scene = await scenes.create({
      homeId: newId("home") as HomeId,
      name: "Mixed via engine",
      steps: [
        { deviceId, capability: "onoff", values: { action: "on" } },
        { deviceId, capability: "brightness", values: { action: "set", level: 999 } }, // invalid
      ],
    });
    expect(await scenes.activate(scene.id)).toBe(1);
  });

  it("§ Part 8 — importScene upserts by source instead of creating duplicates", async () => {
    const { deviceId, scenes } = await setup();
    const first = await scenes.importScene({
      homeId: newId("home") as HomeId,
      name: "Welcome Home",
      steps: [{ deviceId, capability: "onoff", values: { action: "on" } }],
      sourceDriverId: "knx-1",
      sourceSceneId: "scene-3",
    });
    expect(first.imported).toBe(true);
    expect(first.syncStatus).toBe("synced");

    // Re-importing the identical scene must update, not duplicate.
    const second = await scenes.importScene({
      homeId: newId("home") as HomeId,
      name: "Welcome Home",
      steps: [{ deviceId, capability: "onoff", values: { action: "on" } }],
      sourceDriverId: "knx-1",
      sourceSceneId: "scene-3",
    });
    expect(second.id).toBe(first.id);
    expect((await scenes.list())).toHaveLength(1);

    // A source-side rename without `force` marks the local copy stale, never silently overwrites.
    const renamed = await scenes.importScene({
      homeId: newId("home") as HomeId,
      name: "Welcome Home (renamed)",
      steps: [{ deviceId, capability: "onoff", values: { action: "on" } }],
      sourceDriverId: "knx-1",
      sourceSceneId: "scene-3",
    });
    expect(renamed.id).toBe(first.id);
    expect(renamed.name).toBe("Welcome Home"); // unchanged
    expect(renamed.syncStatus).toBe("stale");
    expect((await scenes.list())).toHaveLength(1);
  });
});
