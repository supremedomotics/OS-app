import type { AutomationExecutors } from "@supreme/automations";
import { newId, type DeviceId, type HomeId } from "@supreme/domain-model";
import { describe, expect, it, vi } from "vitest";
import { KeypadMappingEngine } from "./mapping-engine.js";
import { KeypadMappingService } from "./service.js";

function executors(overrides: Partial<AutomationExecutors> = {}): AutomationExecutors {
  return {
    command: vi.fn(async () => {}),
    activateScene: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    getState: vi.fn(async () => null),
    ...overrides,
  };
}

const homeId = () => newId("home") as HomeId;
const devId = () => newId("device") as DeviceId;

describe("KeypadMappingService", () => {
  it("expands {{variable}} references into concrete, valid actions at create time", async () => {
    const ex = executors();
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: ex, sleep: async () => {} }));
    await svc.start();

    const kp = devId();
    const light = devId();
    const m = await svc.create({
      homeId: homeId(),
      name: "Dim step",
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      actions: [{ type: "device_command", deviceId: light, command: { capability: "brightness", action: "set", level: "{{step}}" } }],
      variables: { step: 25 },
    });

    // Stored/validated mapping has a concrete number, never the template string.
    expect(m.actions).toEqual([{ type: "device_command", deviceId: light, command: { capability: "brightness", action: "set", level: 25 } }]);

    await svc.onInputEvent({ type: "short_press", keypadId: kp, control: "btn1", ts: new Date().toISOString() });
    expect(ex.command).toHaveBeenCalledWith(light, { capability: "brightness", action: "set", level: 25 });
  });

  it("rejects a mapping whose action fails validation after expansion (unresolved/wrong-typed field)", async () => {
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: executors(), sleep: async () => {} }));
    await expect(
      svc.create({
        homeId: homeId(),
        name: "Bad",
        input: { keypadId: devId(), control: "btn1", event: "short_press" },
        actions: [{ type: "device_command", deviceId: devId(), command: { capability: "brightness", action: "set", level: "{{missing}}" } }],
        variables: {},
      }),
    ).rejects.toThrow();
  });

  it("update() re-expands variables against the new (or existing) variable set", async () => {
    const ex = executors();
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: ex, sleep: async () => {} }));
    await svc.start();
    const kp = devId();
    const light = devId();
    const m = await svc.create({
      homeId: homeId(),
      name: "Dim step",
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      actions: [{ type: "device_command", deviceId: light, command: { capability: "brightness", action: "set", level: "{{step}}" } }],
      variables: { step: 10 },
    });

    const updated = await svc.update(m.id, {
      actions: [{ type: "device_command", deviceId: light, command: { capability: "brightness", action: "set", level: "{{step}}" } }],
      variables: { step: 60 },
    });

    expect(updated.actions).toEqual([{ type: "device_command", deviceId: light, command: { capability: "brightness", action: "set", level: 60 } }]);
  });

  it("setEnabled(false) stops the mapping from firing", async () => {
    const ex = executors();
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: ex, sleep: async () => {} }));
    await svc.start();
    const kp = devId();
    const m = await svc.create({
      homeId: homeId(),
      name: "Toggle",
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      actions: [{ type: "device_command", deviceId: devId(), command: { capability: "onoff", action: "toggle" } }],
    });

    await svc.setEnabled(m.id, false);
    await svc.onInputEvent({ type: "short_press", keypadId: kp, control: "btn1", ts: new Date().toISOString() });

    expect(ex.command).not.toHaveBeenCalled();
  });

  it("remove() deletes the mapping and stops it firing", async () => {
    const ex = executors();
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: ex, sleep: async () => {} }));
    await svc.start();
    const kp = devId();
    const m = await svc.create({
      homeId: homeId(),
      name: "Toggle",
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      actions: [{ type: "device_command", deviceId: devId(), command: { capability: "onoff", action: "toggle" } }],
    });

    await svc.remove(m.id);
    await expect(svc.get(m.id)).rejects.toThrow("keypad mapping not found");

    await svc.onInputEvent({ type: "short_press", keypadId: kp, control: "btn1", ts: new Date().toISOString() });
    expect(ex.command).not.toHaveBeenCalled();
  });

  it("testRun() executes actions immediately, bypassing conditions", async () => {
    const ex = executors({ getState: vi.fn(async () => null) });
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: ex, sleep: async () => {} }));
    const light = devId();
    const m = await svc.create({
      homeId: homeId(),
      name: "Guarded",
      input: { keypadId: devId(), control: "btn1", event: "short_press" },
      conditions: [{ type: "device_state", deviceId: devId(), capability: "onoff", field: "on", op: "eq", value: true }],
      actions: [{ type: "device_command", deviceId: light, command: { capability: "onoff", action: "on" } }],
    });

    await svc.testRun(m.id);

    expect(ex.command).toHaveBeenCalledWith(light, { capability: "onoff", action: "on" });
  });
});

describe("KeypadMappingService — behavior model create/update (§ Universal Keypad Framework, Stage 3A)", () => {
  it("legacy create() (no behavior/target field at all) still produces a \"direct\" mapping — full backward compatibility", async () => {
    const ex = executors();
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: ex, sleep: async () => {} }));
    await svc.start();
    const kp = devId();
    const light = devId();
    const m = await svc.create({
      homeId: homeId(),
      name: "Legacy toggle",
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      actions: [{ type: "device_command", deviceId: light, command: { capability: "onoff", action: "toggle" } }],
    });
    expect(m.behavior).toBe("direct");
    expect(m.target).toBeNull();
    expect(m.behaviorState).toEqual({ lastDirection: null, cycleIndex: 0 });
    await svc.onInputEvent({ type: "short_press", keypadId: kp, control: "btn1", ts: new Date().toISOString() });
    expect(ex.command).toHaveBeenCalledWith(light, { capability: "onoff", action: "toggle" });
  });

  it("creates a toggle mapping (no actions[] needed) and fires it against live target state", async () => {
    let on = false;
    const ex = executors({
      getState: vi.fn(async () => ({ kind: "onoff", on })),
      command: vi.fn(async (_id, cmd) => { on = cmd.action === "on"; }),
    });
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: ex, sleep: async () => {} }));
    await svc.start();
    const kp = devId();
    const light = devId();
    const m = await svc.create({
      homeId: homeId(),
      name: "Toggle light",
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      behavior: "toggle",
      target: { deviceId: light, capability: "onoff", step: 10 },
    });
    expect(m.behavior).toBe("toggle");
    expect(m.actions).toEqual([]);

    await svc.onInputEvent({ type: "short_press", keypadId: kp, control: "btn1", ts: new Date().toISOString() });
    expect(ex.command).toHaveBeenCalledWith(light, { capability: "onoff", action: "on" });
    expect(on).toBe(true);
  });

  it("creates an alternate mapping and alternates dim direction across firings", async () => {
    let level = 40;
    const ex = executors({
      getState: vi.fn(async () => ({ kind: "brightness", on: true, level })),
      command: vi.fn(async (_id, cmd) => { if (cmd.action === "set") level = cmd.level ?? level; }),
    });
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: ex, sleep: async () => {} }));
    await svc.start();
    const kp = devId();
    const light = devId();
    const m = await svc.create({
      homeId: homeId(),
      name: "Alternate dim",
      input: { keypadId: kp, control: "btn1", event: "hold_start" },
      behavior: "alternate",
      target: { deviceId: light, capability: "brightness", step: 10 },
    });
    expect(m.behaviorState).toEqual({ lastDirection: null, cycleIndex: 0 });

    await svc.onInputEvent({ type: "hold_start", keypadId: kp, control: "btn1", ts: new Date().toISOString() });
    expect(level).toBe(50);
    await svc.onInputEvent({ type: "hold_start", keypadId: kp, control: "btn1", ts: new Date().toISOString() });
    expect(level).toBe(40);
  });

  it("creates a cycle mapping that walks its actions[] one at a time, wrapping around", async () => {
    const ex = executors();
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: ex, sleep: async () => {} }));
    await svc.start();
    const kp = devId();
    const sceneA = devId();
    const sceneB = devId();
    await svc.create({
      homeId: homeId(),
      name: "Cycle scenes",
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      behavior: "cycle",
      target: { deviceId: sceneA, capability: "onoff", step: 10 },
      actions: [
        { type: "device_command", deviceId: sceneA, command: { capability: "onoff", action: "on" } },
        { type: "device_command", deviceId: sceneB, command: { capability: "onoff", action: "on" } },
      ],
    });

    await svc.onInputEvent({ type: "short_press", keypadId: kp, control: "btn1", ts: new Date().toISOString() });
    expect(ex.command).toHaveBeenLastCalledWith(sceneA, { capability: "onoff", action: "on" });
    await svc.onInputEvent({ type: "short_press", keypadId: kp, control: "btn1", ts: new Date().toISOString() });
    expect(ex.command).toHaveBeenLastCalledWith(sceneB, { capability: "onoff", action: "on" });
    await svc.onInputEvent({ type: "short_press", keypadId: kp, control: "btn1", ts: new Date().toISOString() });
    expect(ex.command).toHaveBeenLastCalledWith(sceneA, { capability: "onoff", action: "on" });
  });

  it("creates increment and decrement mappings that always step the same direction", async () => {
    let level = 50;
    const ex = executors({
      getState: vi.fn(async () => ({ kind: "brightness", on: true, level })),
      command: vi.fn(async (_id, cmd) => { if (cmd.action === "set") level = cmd.level ?? level; }),
    });
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: ex, sleep: async () => {} }));
    await svc.start();
    const kp = devId();
    const light = devId();
    await svc.create({
      homeId: homeId(),
      name: "Increment",
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      behavior: "increment",
      target: { deviceId: light, capability: "brightness", step: 5 },
    });
    await svc.onInputEvent({ type: "short_press", keypadId: kp, control: "btn1", ts: new Date().toISOString() });
    expect(level).toBe(55);
    await svc.onInputEvent({ type: "short_press", keypadId: kp, control: "btn1", ts: new Date().toISOString() });
    expect(level).toBe(60); // increment never alternates — always up

    const m2 = await svc.create({
      homeId: homeId(),
      name: "Decrement",
      input: { keypadId: kp, control: "btn2", event: "short_press" },
      behavior: "decrement",
      target: { deviceId: light, capability: "brightness", step: 5 },
    });
    expect(m2.target).toEqual({ deviceId: light, capability: "brightness", step: 5 });
    await svc.onInputEvent({ type: "short_press", keypadId: kp, control: "btn2", ts: new Date().toISOString() });
    expect(level).toBe(55); // decrement steps down from whatever level is now (60 -> 55)
  });

  it("target (deviceId/capability/step) round-trips through create -> get exactly as sent", async () => {
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: executors(), sleep: async () => {} }));
    const light = devId();
    const created = await svc.create({
      homeId: homeId(),
      name: "Serialize target",
      input: { keypadId: devId(), control: "btn1", event: "short_press" },
      behavior: "toggle",
      target: { deviceId: light, capability: "onoff", step: 25 },
    });
    const fetched = await svc.get(created.id);
    expect(fetched.target).toEqual({ deviceId: light, capability: "onoff", step: 25 });
  });

  it("update() can change behavior/target on an existing mapping, without disturbing its persisted behaviorState via the patch itself", async () => {
    const ex = executors({ getState: vi.fn(async () => ({ kind: "onoff", on: false })) });
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: ex, sleep: async () => {} }));
    const kp = devId();
    const oldTarget = devId();
    const newTarget = devId();
    const m = await svc.create({
      homeId: homeId(),
      name: "Switchable",
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      behavior: "toggle",
      target: { deviceId: oldTarget, capability: "onoff", step: 10 },
    });

    const updated = await svc.update(m.id, { target: { deviceId: newTarget, capability: "onoff", step: 10 } });
    expect(updated.behavior).toBe("toggle"); // unspecified in the patch -> unchanged
    expect(updated.target).toEqual({ deviceId: newTarget, capability: "onoff", step: 10 });

    // Switching a mapping back to "direct" requires an explicit actions[] (still enforced).
    await expect(svc.update(m.id, { behavior: "direct" })).rejects.toThrow();
    const backToDirect = await svc.update(m.id, {
      behavior: "direct",
      actions: [{ type: "device_command", deviceId: newTarget, command: { capability: "onoff", action: "on" } }],
    });
    expect(backToDirect.behavior).toBe("direct");
  });

  it("update() omitting target/behavior entirely leaves both, and the persisted behaviorState, untouched", async () => {
    const ex = executors({ getState: vi.fn(async () => ({ kind: "brightness", on: true, level: 50 })) });
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: ex, sleep: async () => {} }));
    await svc.start();
    const kp = devId();
    const light = devId();
    const m = await svc.create({
      homeId: homeId(),
      name: "Alt dim",
      input: { keypadId: kp, control: "btn1", event: "hold_start" },
      behavior: "alternate",
      target: { deviceId: light, capability: "brightness", step: 10 },
    });
    // Fire once so behaviorState is no longer the fresh default.
    await svc.onInputEvent({ type: "hold_start", keypadId: kp, control: "btn1", ts: new Date().toISOString() });
    const afterFire = await svc.get(m.id);
    expect(afterFire.behaviorState.lastDirection).toBe("up");

    // An unrelated rename must never reset the mapping's behaviorState, since the patch
    // type has no such field to even accidentally carry one.
    const renamed = await svc.update(m.id, { name: "Alt dim (renamed)" });
    expect(renamed.name).toBe("Alt dim (renamed)");
    expect(renamed.target).toEqual({ deviceId: light, capability: "brightness", step: 10 });
    expect(renamed.behaviorState.lastDirection).toBe("up");
  });

  it("validation: a non-\"direct\" behavior with no target is rejected", async () => {
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: executors(), sleep: async () => {} }));
    await expect(
      svc.create({
        homeId: homeId(),
        name: "No target",
        input: { keypadId: devId(), control: "btn1", event: "short_press" },
        behavior: "toggle",
      }),
    ).rejects.toThrow();
  });

  it("validation: a \"direct\" mapping with empty actions is rejected, exactly as before Stage 3A", async () => {
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: executors(), sleep: async () => {} }));
    await expect(
      svc.create({
        homeId: homeId(),
        name: "No actions",
        input: { keypadId: devId(), control: "btn1", event: "short_press" },
      }),
    ).rejects.toThrow();
  });

  it("validation: a \"cycle\" mapping with empty actions is rejected", async () => {
    const svc = new KeypadMappingService(new KeypadMappingEngine({ executors: executors(), sleep: async () => {} }));
    await expect(
      svc.create({
        homeId: homeId(),
        name: "Empty cycle",
        input: { keypadId: devId(), control: "btn1", event: "short_press" },
        behavior: "cycle",
        target: { deviceId: devId(), capability: "onoff", step: 10 },
      }),
    ).rejects.toThrow();
  });
});
