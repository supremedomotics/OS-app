import { describe, expect, it } from "vitest";
import { IntentDefinition, IntentTarget } from "./intents.js";
import { newId } from "./ids.js";

describe("IntentDefinition", () => {
  it("accepts a well-formed capability-driven definition", () => {
    const def = IntentDefinition.parse({
      id: "toggleLight",
      name: "Toggle Light",
      category: "lighting",
      requiredCapabilities: ["onoff"],
      targetKinds: ["device", "room"],
    });
    expect(def.version).toBe("1.0.0"); // default applied
    expect(def.requiredCapabilities).toEqual(["onoff"]);
  });

  it("accepts a system-level definition with no required capability", () => {
    const def = IntentDefinition.parse({
      id: "runScene",
      name: "Run Scene",
      category: "system",
      targetKinds: ["scene"],
    });
    expect(def.requiredCapabilities).toEqual([]);
  });

  it("rejects a non-camelCase id", () => {
    expect(() =>
      IntentDefinition.parse({ id: "Toggle-Light", name: "x", category: "lighting", targetKinds: ["device"] }),
    ).toThrow();
  });

  it("rejects an unknown category", () => {
    expect(() =>
      IntentDefinition.parse({ id: "foo", name: "x", category: "not-a-category", targetKinds: ["device"] }),
    ).toThrow();
  });

  it("validates parameter specs", () => {
    const def = IntentDefinition.parse({
      id: "setBrightness",
      name: "Set Brightness",
      category: "lighting",
      requiredCapabilities: ["brightness"],
      targetKinds: ["device", "room"],
      parameters: [{ key: "level", type: "number", required: true, min: 0, max: 100 }],
    });
    expect(def.parameters[0]!.min).toBe(0);
  });
});

describe("IntentTarget", () => {
  it("discriminates device/room/scene/automation/home targets", () => {
    expect(IntentTarget.parse({ kind: "device", deviceId: newId("device") }).kind).toBe("device");
    expect(IntentTarget.parse({ kind: "room", roomId: newId("room") }).kind).toBe("room");
    expect(IntentTarget.parse({ kind: "scene", sceneId: newId("scene") }).kind).toBe("scene");
    expect(IntentTarget.parse({ kind: "automation", automationId: newId("automation") }).kind).toBe("automation");
    expect(IntentTarget.parse({ kind: "home" }).kind).toBe("home");
  });

  it("rejects a device target missing its deviceId", () => {
    expect(() => IntentTarget.parse({ kind: "device" })).toThrow();
  });
});
