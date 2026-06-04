import { describe, expect, it } from "vitest";
import { plan } from "./planner.js";
import type { AssistantContext } from "./types.js";

const ctx: AssistantContext = {
  rooms: [
    { id: "room_living", name: "Living Room" },
    { id: "room_kitchen", name: "Kitchen" },
  ],
  devices: [
    { id: "dev_living_lights", name: "Living Room Lights", roomId: "room_living", supremeType: "dimmer", capabilities: ["onoff", "brightness"] },
    { id: "dev_living_blinds", name: "Living Room Blinds", roomId: "room_living", supremeType: "cover", capabilities: ["position"] },
    { id: "dev_kitchen_lights", name: "Kitchen Lights", roomId: "room_kitchen", supremeType: "light", capabilities: ["onoff"] },
    { id: "dev_front_door", name: "Front Door", roomId: null, supremeType: "lock", capabilities: ["lock"] },
    { id: "dev_motion", name: "Hallway Motion", roomId: null, supremeType: "sensor", capabilities: ["onoff"] },
  ],
};

describe("AI planner — immediate commands", () => {
  it("dims a room's lights to a percentage", () => {
    const r = plan({ utterance: "dim the living room lights to 20%", context: ctx });
    expect(r.kind).toBe("actions");
    if (r.kind !== "actions") return;
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toMatchObject({
      deviceId: "dev_living_lights",
      command: { capability: "brightness", action: "set", level: 20 },
    });
  });

  it("turns off all lights across the home", () => {
    const r = plan({ utterance: "turn off all the lights", context: ctx });
    expect(r.kind).toBe("actions");
    if (r.kind !== "actions") return;
    const ids = r.commands.map((c) => c.deviceId).sort();
    expect(ids).toEqual(["dev_kitchen_lights", "dev_living_lights"]);
  });

  it("unlocks a named device", () => {
    const r = plan({ utterance: "unlock the front door", context: ctx });
    expect(r.kind).toBe("actions");
    if (r.kind !== "actions") return;
    expect(r.commands[0]!.command).toEqual({ capability: "lock", action: "unlock" });
  });
});

describe("AI planner — scenes & automations", () => {
  it("builds a scene from an explicit request", () => {
    const r = plan({ utterance: "create a movie scene that dims the living room lights to 10%", context: ctx });
    expect(r.kind).toBe("scene");
    if (r.kind !== "scene") return;
    expect(r.name).toBe("Movie Scene");
    expect(r.steps[0]).toMatchObject({ deviceId: "dev_living_lights", capability: "brightness", values: { action: "set", level: 10 } });
  });

  it("builds a time-triggered automation", () => {
    const r = plan({ utterance: "at 11pm turn off all the lights", context: ctx });
    expect(r.kind).toBe("automation");
    if (r.kind !== "automation") return;
    expect(r.triggers[0]).toEqual({ type: "time", at: "23:00", days: [] });
    expect(r.actions.length).toBeGreaterThan(0);
    expect(r.actions[0]!.type).toBe("device_command");
  });

  it("builds a device-state-triggered automation", () => {
    const r = plan({ utterance: "when hallway motion turns on, turn on the kitchen lights", context: ctx });
    expect(r.kind).toBe("automation");
    if (r.kind !== "automation") return;
    expect(r.triggers[0]).toMatchObject({ type: "device_state", deviceId: "dev_motion", field: "on" });
  });

  it("answers when nothing is actionable", () => {
    const r = plan({ utterance: "what is the meaning of life", context: ctx });
    expect(r.kind).toBe("answer");
  });
});
