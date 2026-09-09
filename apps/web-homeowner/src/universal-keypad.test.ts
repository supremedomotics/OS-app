import { describe, expect, it } from "vitest";
import { KeypadMapping, newId } from "@supreme/domain-model";
import type { Device, DeviceId, HomeId, Room, RoomId } from "@supreme/domain-model";

const kpId = () => newId("device") as DeviceId;
const HOME = newId("home") as HomeId;
const [KP1, L1, L2] = [kpId(), kpId(), kpId()];
import {
  behaviorRequiresActions,
  behaviorRequiresTarget,
  behaviorUsesStep,
  buildCreateKeypadMappingRequest,
  buildUpdateKeypadMappingRequest,
  emptyKeypadMappingForm,
  groupKeypadsByRoom,
  mappingToFormState,
  summarizeMapping,
  targetableCapabilities,
  targetCapabilitiesForBehavior,
  validateKeypadMappingForm,
  type KeypadMappingFormState,
} from "./universal-keypad-logic.js";

/**
 * § Supreme Universal Keypad, Stage 3B — pure-logic tests for the Universal Keypad page.
 * This repo has no component-rendering test infra (no @testing-library/react/jsdom — see
 * navigation.test.ts/room-keypad-category.test.ts for the established pattern), so every
 * behavior the spec asks to be tested is expressed here as a plain function over the SAME
 * `Device`/`Room`/`KeypadMapping` entities the real page consumes — list/discovery/room-
 * grouping, behavior selection, target selection, and the save/update request shapes for
 * every one of the six behaviors.
 */

function room(id: string, name: string): Room {
  return { id: id as RoomId, homeId: "home-1" as HomeId, name, building: null, floor: 0, area: null, areaType: "office", sortOrder: 0, icon: null, heroImageUrl: null, parentRoomId: null };
}

function keypad(id: string, name: string, roomId: string | null, overrides: Partial<Device> = {}): Device {
  return {
    id: id as DeviceId, homeId: "home-1" as HomeId, roomId: roomId as RoomId | null, name,
    supremeType: "keypad", manufacturer: null, model: null, driverId: null, status: "online",
    capabilities: [], state: {}, metadata: {}, ...overrides,
  };
}

function light(id: string, name: string, roomId: string): Device {
  return {
    id: id as DeviceId, homeId: "home-1" as HomeId, roomId: roomId as RoomId, name,
    supremeType: "dimmer", manufacturer: null, model: null, driverId: null, status: "online",
    capabilities: [{ kind: "onoff", config: {} }, { kind: "brightness", config: {} }], state: {}, metadata: {},
  };
}

describe("Universal Keypad — discovery / room grouping (§2, §3)", () => {
  it("keypad discovery/list: groups keypads by room, ignoring non-keypad devices", () => {
    const livingRoom = room("r1", "Living Room");
    const devices = [keypad("kp1", "Entrance Keypad", "r1"), light("l1", "Ceiling Light", "r1")];
    const groups = groupKeypadsByRoom(devices, [livingRoom]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.room?.name).toBe("Living Room");
    expect(groups[0]!.keypads.map((d) => d.id)).toEqual(["kp1"]);
  });

  it("room grouping: multiple rooms plus an Unassigned bucket, sorted with Unassigned last", () => {
    const bedroom = room("r2", "Bedroom");
    const living = room("r1", "Living Room");
    const devices = [
      keypad("kp1", "Sofa Keypad", "r1"),
      keypad("kp2", "Bedside Keypad", "r2"),
      keypad("kp3", "Spare Keypad", null),
    ];
    const groups = groupKeypadsByRoom(devices, [living, bedroom]);
    expect(groups.map((g) => g.room?.name ?? "Unassigned")).toEqual(["Bedroom", "Living Room", "Unassigned"]);
    expect(groups.find((g) => g.room === null)?.keypads.map((d) => d.id)).toEqual(["kp3"]);
  });

  it("keypad with zero actuator capabilities lists/groups exactly like any other keypad — never dropped for having capabilities: []", () => {
    const kp = keypad("kp1", "Bare Keypad", "r1");
    expect(kp.capabilities).toEqual([]);
    const groups = groupKeypadsByRoom([kp], [room("r1", "Living Room")]);
    expect(groups[0]!.keypads).toHaveLength(1);
  });

  it("same Unit ID on two network instances: two distinct Supreme devices are grouped independently, never merged/deduped", () => {
    const net1 = keypad("dev-net1-unit4", "Bedside Keypad", "r1", { metadata: { backendId: "casambi:drv_net1:4" } });
    const net2 = keypad("dev-net2-unit4", "Bedside Keypad", "r1", { metadata: { backendId: "casambi:drv_net2:4" } });
    const groups = groupKeypadsByRoom([net1, net2], [room("r1", "Living Room")]);
    expect(groups[0]!.keypads).toHaveLength(2);
    expect(new Set(groups[0]!.keypads.map((d) => d.id)).size).toBe(2);
  });

  it("a device that isn't a keypad never appears in any group", () => {
    const groups = groupKeypadsByRoom([light("l1", "Light", "r1")], [room("r1", "Living Room")]);
    expect(groups).toHaveLength(0);
  });
});

describe("Universal Keypad — behavior selection (§5)", () => {
  it("only non-direct behaviors require a target", () => {
    expect(behaviorRequiresTarget("direct")).toBe(false);
    for (const b of ["toggle", "alternate", "cycle", "increment", "decrement"] as const) {
      expect(behaviorRequiresTarget(b)).toBe(true);
    }
  });

  it("only direct/cycle require the action list", () => {
    expect(behaviorRequiresActions("direct")).toBe(true);
    expect(behaviorRequiresActions("cycle")).toBe(true);
    expect(behaviorRequiresActions("toggle")).toBe(false);
    expect(behaviorRequiresActions("alternate")).toBe(false);
    expect(behaviorRequiresActions("increment")).toBe(false);
    expect(behaviorRequiresActions("decrement")).toBe(false);
  });

  it("only alternate/increment/decrement use the step field", () => {
    expect(behaviorUsesStep("alternate")).toBe(true);
    expect(behaviorUsesStep("increment")).toBe(true);
    expect(behaviorUsesStep("decrement")).toBe(true);
    expect(behaviorUsesStep("direct")).toBe(false);
    expect(behaviorUsesStep("toggle")).toBe(false);
    expect(behaviorUsesStep("cycle")).toBe(false);
  });
});

describe("Universal Keypad — target selection (§6)", () => {
  it("targetableCapabilities excludes read-only capabilities (sensor)", () => {
    const sensor: Device = { ...light("s1", "Lux Sensor", "r1"), capabilities: [{ kind: "sensor", config: {} }] };
    expect(targetableCapabilities(sensor)).toEqual([]);
  });

  it("targetableCapabilities returns every commandable capability the device actually has", () => {
    expect(targetableCapabilities(light("l1", "Light", "r1"))).toEqual(["onoff", "brightness"]);
  });
});

describe("Universal Keypad — behavior/capability compatibility filtering (§ live-confirmed fix: Toggle + Color threw 'request validation failed')", () => {
  const colorLight: Device = { ...light("cl1", "Color Light", "r1"), capabilities: [{ kind: "onoff", config: {} }, { kind: "brightness", config: {} }, { kind: "color", config: {} }] };

  it("'toggle' excludes 'color' — the same TOGGLE_CAPABLE_CAPABILITIES list the backend schema enforces", () => {
    expect(targetCapabilitiesForBehavior(colorLight, "toggle")).toEqual(["onoff", "brightness"]);
    expect(targetCapabilitiesForBehavior(colorLight, "toggle")).not.toContain("color");
  });

  it("'alternate'/'increment'/'decrement' only offer level-shaped capabilities (brightness/position), excluding onoff and color", () => {
    expect(targetCapabilitiesForBehavior(colorLight, "alternate")).toEqual(["brightness"]);
    expect(targetCapabilitiesForBehavior(colorLight, "increment")).toEqual(["brightness"]);
    expect(targetCapabilitiesForBehavior(colorLight, "decrement")).toEqual(["brightness"]);
  });

  it("'direct'/'cycle' have no target.capability restriction — every commandable capability stays offered", () => {
    expect(targetCapabilitiesForBehavior(colorLight, "direct")).toEqual(["onoff", "brightness", "color"]);
    expect(targetCapabilitiesForBehavior(colorLight, "cycle")).toEqual(["onoff", "brightness", "color"]);
  });
});

describe("Universal Keypad — short press / long press are independently configurable (§4, §10)", () => {
  it("short press and long press start/end are stored as three DIFFERENT event values, never combined", () => {
    const base = emptyKeypadMappingForm("kp1" as DeviceId, "button-0", "short_press");
    const short = buildCreateKeypadMappingRequest({ ...base, name: "Short", behavior: "direct", actions: [{ deviceId: "l1" as DeviceId, capability: "onoff", action: "toggle", params: {} }] });
    const longStart = buildCreateKeypadMappingRequest({ ...base, name: "Long start", event: "hold_start", behavior: "direct", actions: [{ deviceId: "l1" as DeviceId, capability: "onoff", action: "on", params: {} }] });
    const longEnd = buildCreateKeypadMappingRequest({ ...base, name: "Long end", event: "hold_end", behavior: "direct", actions: [{ deviceId: "l1" as DeviceId, capability: "onoff", action: "off", params: {} }] });
    expect(short.input.event).toBe("short_press");
    expect(longStart.input.event).toBe("hold_start");
    expect(longEnd.input.event).toBe("hold_end");
    // Three independent requests for the SAME control — the UI never forces one config to
    // cover multiple event types (§10: preserved for a future continuous-dim/volume use).
    expect(new Set([short.input.event, longStart.input.event, longEnd.input.event]).size).toBe(3);
  });
});

describe("Universal Keypad — saving each behavior (§7, §8, §9, §11)", () => {
  const base = (behavior: KeypadMappingFormState["behavior"]): KeypadMappingFormState => ({
    ...emptyKeypadMappingForm("kp1" as DeviceId, "button-0", "short_press"),
    name: "Test mapping",
    behavior,
  });

  it("toggle: request carries behavior + target only, no actions, no local boolean field anywhere", () => {
    const form: KeypadMappingFormState = { ...base("toggle"), targetDeviceId: "l1" as DeviceId, targetCapability: "onoff" };
    const req = buildCreateKeypadMappingRequest(form);
    expect(req.behavior).toBe("toggle");
    expect(req.target).toEqual({ deviceId: "l1", capability: "onoff", step: 10 });
    expect(req.actions).toEqual([]);
    expect(req).not.toHaveProperty("behaviorState");
  });

  it("alternate: request carries target + step; behaviorState/lastDirection are never part of the payload", () => {
    const form: KeypadMappingFormState = { ...base("alternate"), targetDeviceId: "l1" as DeviceId, targetCapability: "brightness", step: 15 };
    const req = buildCreateKeypadMappingRequest(form);
    expect(req.behavior).toBe("alternate");
    expect(req.target).toEqual({ deviceId: "l1", capability: "brightness", step: 15 });
    expect(JSON.stringify(req)).not.toContain("lastDirection");
    expect(JSON.stringify(req)).not.toContain("behaviorState");
  });

  it("cycle: request carries target AND the ordered action list (the mapping engine executes it, not React)", () => {
    const form: KeypadMappingFormState = {
      ...base("cycle"),
      targetDeviceId: "l1" as DeviceId,
      targetCapability: "onoff",
      actions: [
        { deviceId: "l1" as DeviceId, capability: "onoff", action: "on", params: {} },
        { deviceId: "l1" as DeviceId, capability: "onoff", action: "off", params: {} },
      ],
    };
    const req = buildCreateKeypadMappingRequest(form);
    expect(req.behavior).toBe("cycle");
    expect(req.actions).toEqual([
      { type: "device_command", deviceId: "l1", command: { capability: "onoff", action: "on" } },
      { type: "device_command", deviceId: "l1", command: { capability: "onoff", action: "off" } },
    ]);
    // Cycle position (cycleIndex) is never part of what the UI sends — engine-owned.
    expect(JSON.stringify(req)).not.toContain("cycleIndex");
  });

  it("increment/decrement: request carries target + step, no actions", () => {
    const incForm: KeypadMappingFormState = { ...base("increment"), targetDeviceId: "l1" as DeviceId, targetCapability: "brightness", step: 20 };
    const incReq = buildCreateKeypadMappingRequest(incForm);
    expect(incReq.behavior).toBe("increment");
    expect(incReq.target?.step).toBe(20);
    expect(incReq.actions).toEqual([]);

    const decForm: KeypadMappingFormState = { ...incForm, behavior: "decrement" };
    const decReq = buildCreateKeypadMappingRequest(decForm);
    expect(decReq.behavior).toBe("decrement");
  });

  it("legacy direct mapping: request shape is exactly the pre-Stage-2 actions[]-only mapping, target is null", () => {
    const form: KeypadMappingFormState = {
      ...base("direct"),
      actions: [{ deviceId: "l1" as DeviceId, capability: "onoff", action: "toggle", params: {} }],
    };
    const req = buildCreateKeypadMappingRequest(form);
    expect(req.behavior).toBe("direct");
    expect(req.target).toBeNull();
    expect(req.actions).toEqual([{ type: "device_command", deviceId: "l1", command: { capability: "onoff", action: "toggle" } }]);
  });
});

describe("Universal Keypad — validation (§11)", () => {
  it("rejects a non-direct behavior with no target", () => {
    const form = { ...emptyKeypadMappingForm("kp1" as DeviceId, "button-0", "short_press"), name: "X", behavior: "toggle" as const };
    expect(validateKeypadMappingForm(form)).toMatch(/target/i);
    expect(() => buildCreateKeypadMappingRequest(form)).toThrow();
  });

  it("rejects a direct/cycle mapping with no actions", () => {
    const direct = { ...emptyKeypadMappingForm("kp1" as DeviceId, "button-0", "short_press"), name: "X", behavior: "direct" as const };
    expect(validateKeypadMappingForm(direct)).toMatch(/action/i);
    const cycle = { ...direct, behavior: "cycle" as const, targetDeviceId: "l1" as DeviceId, targetCapability: "onoff" as const };
    expect(validateKeypadMappingForm(cycle)).toMatch(/cycle/i);
  });

  it("rejects a mapping with no name or no control", () => {
    const noName = { ...emptyKeypadMappingForm("kp1" as DeviceId, "button-0", "short_press"), behavior: "direct" as const, actions: [{ deviceId: "l1" as DeviceId, capability: "onoff" as const, action: "toggle", params: {} }] };
    expect(validateKeypadMappingForm(noName)).toMatch(/name/i);
    const noControl = { ...noName, name: "X", control: "" };
    expect(validateKeypadMappingForm(noControl)).toMatch(/button|control/i);
  });
});

describe("Universal Keypad — press-slot summary shows target device · capability · behavior, never the raw mapping name (§ thumb rule for every keypad/button/press type)", () => {
  const devices = [light(L1, "Conference Hanging", "room-1"), light(L2, "Pantry Downlight", "room-1")];

  it("a toggle mapping (target-based) summarizes as 'device · capability · behavior'", () => {
    const stored = KeypadMapping.parse({
      id: newId("keypadMapping"), homeId: HOME, name: "SD1PN3S4 — 1", input: { keypadId: KP1, control: "1", event: "short_press" },
      behavior: "toggle", target: { deviceId: L1, capability: "onoff", step: 10 },
    });
    expect(summarizeMapping(stored, devices)).toBe("Conference Hanging · Power · Toggle");
  });

  it("a direct mapping (action-based) summarizes from its first device_command action", () => {
    const stored = KeypadMapping.parse({
      id: newId("keypadMapping"), homeId: HOME, name: "SD1PN3S4 — 2", input: { keypadId: KP1, control: "2", event: "short_press" },
      actions: [{ type: "device_command", deviceId: L2, command: { capability: "onoff", action: "on" } }],
    });
    expect(summarizeMapping(stored, devices)).toBe("Pantry Downlight · Power · Direct");
  });

  it("a direct mapping with multiple device_command actions notes how many more", () => {
    const stored = KeypadMapping.parse({
      id: newId("keypadMapping"), homeId: HOME, name: "Multi-action", input: { keypadId: KP1, control: "3", event: "short_press" },
      actions: [
        { type: "device_command", deviceId: L1, command: { capability: "onoff", action: "on" } },
        { type: "device_command", deviceId: L2, command: { capability: "onoff", action: "on" } },
      ],
    });
    expect(summarizeMapping(stored, devices)).toBe("Conference Hanging · Power · Direct +1 more");
  });

  it("a cycle mapping always has a target (schema requirement) — summarizeMapping prefers it, matching what actually fires", () => {
    const stored = KeypadMapping.parse({
      id: newId("keypadMapping"), homeId: HOME, name: "Cycle", input: { keypadId: KP1, control: "4", event: "short_press" },
      behavior: "cycle", target: { deviceId: L1, capability: "onoff", step: 10 },
      actions: [
        { type: "device_command", deviceId: L1, command: { capability: "onoff", action: "on" } },
        { type: "device_command", deviceId: L2, command: { capability: "onoff", action: "on" } },
      ],
    });
    expect(summarizeMapping(stored, devices)).toBe("Conference Hanging · Power · Cycle");
  });

  it("falls back to the mapping's own name only when it genuinely has no device to show (scene/notify-only)", () => {
    const stored = KeypadMapping.parse({
      id: newId("keypadMapping"), homeId: HOME, name: "Notify only", input: { keypadId: KP1, control: "4", event: "short_press" },
      actions: [{ type: "notify", level: "info", title: "Pressed", body: "Pressed" }],
    });
    expect(summarizeMapping(stored, devices)).toBe("Notify only");
  });
});

describe("Universal Keypad — editing an existing mapping (§11)", () => {
  it("mappingToFormState never reads behaviorState into editable fields, even when the mapping has live runtime state", () => {
    const stored = KeypadMapping.parse({
      id: newId("keypadMapping"), homeId: HOME, name: "Alt dim", input: { keypadId: KP1, control: "btn1", event: "hold_start" },
      behavior: "alternate", target: { deviceId: L1, capability: "brightness", step: 10 },
      behaviorState: { lastDirection: "up", cycleIndex: 0 },
    });
    const form = mappingToFormState(stored);
    expect(form).not.toHaveProperty("behaviorState");
    expect(form).not.toHaveProperty("lastDirection");
    // Round-tripping the form back into an update request still carries no behaviorState.
    const req = buildUpdateKeypadMappingRequest(form);
    expect(req).not.toHaveProperty("behaviorState");
    expect(JSON.stringify(req)).not.toContain("lastDirection");
  });

  it("editing a legacy direct mapping loads its actions[] correctly and re-saves unchanged", () => {
    const stored = KeypadMapping.parse({
      id: newId("keypadMapping"), homeId: HOME, name: "Legacy toggle", input: { keypadId: KP1, control: "btn2", event: "short_press" },
      actions: [{ type: "device_command", deviceId: L1, command: { capability: "onoff", action: "toggle" } }],
    });
    expect(stored.behavior).toBe("direct");
    expect(stored.target).toBeNull();
    const form = mappingToFormState(stored);
    expect(form.behavior).toBe("direct");
    expect(form.actions).toEqual([{ deviceId: L1, capability: "onoff", action: "toggle", params: {} }]);
    const req = buildUpdateKeypadMappingRequest(form);
    expect(req.actions).toEqual([{ type: "device_command", deviceId: L1, command: { capability: "onoff", action: "toggle" } }]);
  });

  it("editing a toggle mapping to change its target produces a clean update request", () => {
    const stored = KeypadMapping.parse({
      id: newId("keypadMapping"), homeId: HOME, name: "Toggle", input: { keypadId: KP1, control: "btn3", event: "short_press" },
      behavior: "toggle", target: { deviceId: L1, capability: "onoff", step: 10 },
    });
    const form = mappingToFormState(stored);
    const updated = { ...form, targetDeviceId: L2 };
    const req = buildUpdateKeypadMappingRequest(updated);
    expect(req.target).toEqual({ deviceId: L2, capability: "onoff", step: 10 });
  });
});
