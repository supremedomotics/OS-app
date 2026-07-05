import { newId, type DeviceId, type HomeId } from "@supreme/domain-model";
import { MockAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
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
});
