import { KeypadMapping, newId, type CapabilityState, type DeviceId, type HomeId, type KeypadInputEvent } from "@supreme/domain-model";
import type { AutomationExecutors } from "@supreme/automations";
import { describe, expect, it, vi } from "vitest";
import { KeypadMappingEngine } from "./mapping-engine.js";

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

function mapping(overrides: Partial<Parameters<typeof KeypadMapping.parse>[0]> = {}) {
  return KeypadMapping.parse({
    id: newId("keypadMapping"),
    homeId: homeId(),
    name: "Test mapping",
    input: { keypadId: devId(), control: "btn1", event: "short_press" },
    actions: [{ type: "device_command", deviceId: devId(), command: { capability: "onoff", action: "toggle" } }],
    ...overrides,
  });
}

function pressEvent(keypadId: DeviceId, control = "btn1", type: KeypadInputEvent["type"] = "short_press"): KeypadInputEvent {
  return { type, keypadId, control, ts: new Date().toISOString() } as KeypadInputEvent;
}

describe("KeypadMappingEngine", () => {
  it("fires the matching mapping's actions on the matching input event", async () => {
    const ex = executors();
    const engine = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    const target = devId();
    const kp = devId();
    const m = mapping({ input: { keypadId: kp, control: "btn1", event: "short_press" }, actions: [{ type: "device_command", deviceId: target, command: { capability: "onoff", action: "toggle" } }] });
    engine.setMappings([m]);

    await engine.onInputEvent(pressEvent(kp, "btn1", "short_press"));

    expect(ex.command).toHaveBeenCalledWith(target, { capability: "onoff", action: "toggle" });
  });

  it("does not fire for a different control, keypad, or event type", async () => {
    const ex = executors();
    const engine = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    const kp = devId();
    const m = mapping({ input: { keypadId: kp, control: "btn1", event: "short_press" } });
    engine.setMappings([m]);

    await engine.onInputEvent(pressEvent(devId(), "btn1", "short_press")); // wrong keypad
    await engine.onInputEvent(pressEvent(kp, "btn2", "short_press")); // wrong control
    await engine.onInputEvent(pressEvent(kp, "btn1", "long_press")); // wrong event type

    expect(ex.command).not.toHaveBeenCalled();
  });

  it("skips disabled mappings", async () => {
    const ex = executors();
    const engine = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    const kp = devId();
    engine.setMappings([mapping({ enabled: false, input: { keypadId: kp, control: "btn1", event: "short_press" } })]);
    await engine.onInputEvent(pressEvent(kp));
    expect(ex.command).not.toHaveBeenCalled();
  });

  it("blocks actions when a device_state condition fails, and records why", async () => {
    const guard = devId();
    const kp = devId();
    const ex = executors({
      getState: vi.fn(async () => ({ kind: "onoff", on: false }) as CapabilityState),
    });
    const engine = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    const m = mapping({
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      conditions: [{ type: "device_state", deviceId: guard, capability: "onoff", field: "on", op: "eq", value: true }],
    });
    engine.setMappings([m]);

    await engine.onInputEvent(pressEvent(kp));

    expect(ex.command).not.toHaveBeenCalled();
    const runs = engine.recentRuns(m.id);
    expect(runs[0]!.conditionsPassed).toBe(false);
    expect(runs[0]!.failedCondition).toContain("onoff.on");
  });

  it("runs a delay action via the injected sleep, and records per-action traces", async () => {
    const ex = executors();
    const sleep = vi.fn(async () => {});
    const engine = new KeypadMappingEngine({ executors: ex, sleep });
    const target = devId();
    const kp = devId();
    const m = mapping({
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      actions: [
        { type: "delay", ms: 250 },
        { type: "device_command", deviceId: target, command: { capability: "onoff", action: "on" } },
      ],
    });
    engine.setMappings([m]);

    await engine.onInputEvent(pressEvent(kp));

    expect(sleep).toHaveBeenCalledWith(250);
    expect(ex.command).toHaveBeenCalledWith(target, { capability: "onoff", action: "on" });
    const runs = engine.recentRuns(m.id);
    expect(runs[0]!.actions.map((a) => a.type)).toEqual(["delay", "device_command"]);
    expect(runs[0]!.ok).toBe(true);
  });

  it("run() (manual test) skips conditions", async () => {
    const ex = executors({ getState: vi.fn(async () => ({ kind: "onoff", on: false }) as CapabilityState) });
    const engine = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    const target = devId();
    const m = mapping({
      conditions: [{ type: "device_state", deviceId: devId(), capability: "onoff", field: "on", op: "eq", value: true }],
      actions: [{ type: "device_command", deviceId: target, command: { capability: "onoff", action: "on" } }],
    });

    await engine.run(m);

    expect(ex.command).toHaveBeenCalledWith(target, { capability: "onoff", action: "on" });
  });

  it("stops on the first failing action and reports the error", async () => {
    const kp = devId();
    const ex = executors({ command: vi.fn(async () => { throw new Error("driver offline"); }) });
    const engine = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    const m = mapping({ input: { keypadId: kp, control: "btn1", event: "short_press" } });
    engine.setMappings([m]);

    await engine.onInputEvent(pressEvent(kp));

    const run = engine.recentRuns(m.id)[0]!;
    expect(run.ok).toBe(false);
    expect(run.error).toContain("driver offline");
  });
});

describe("KeypadMappingEngine — behaviors (§ Supreme Universal Keypad, Stage 2)", () => {
  it("toggle: Light OFF -> Short Press -> ON, reading live state through the SAME event pipeline as any other mapping", async () => {
    const kp = devId();
    const light = devId();
    let on = false;
    const ex = executors({
      getState: vi.fn(async () => ({ kind: "onoff", on }) as CapabilityState),
      command: vi.fn(async (_id, cmd) => { if (cmd.capability === "onoff" && cmd.action !== "toggle") on = cmd.action === "on"; }),
    });
    const engine = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    const m = mapping({
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      actions: [],
      behavior: "toggle",
      target: { deviceId: light, capability: "onoff", step: 10 },
    });
    engine.setMappings([m]);

    await engine.onInputEvent(pressEvent(kp));
    expect(ex.command).toHaveBeenCalledWith(light, { capability: "onoff", action: "on" });
    expect(on).toBe(true);

    await engine.onInputEvent(pressEvent(kp));
    expect(ex.command).toHaveBeenLastCalledWith(light, { capability: "onoff", action: "off" });
    expect(on).toBe(false);

    // An external interface flips it back on, bypassing the keypad entirely.
    on = true;
    await engine.onInputEvent(pressEvent(kp));
    expect(ex.command).toHaveBeenLastCalledWith(light, { capability: "onoff", action: "off" });
  });

  it("alternate: Long Press -> DIM UP, next -> DIM DOWN, next -> DIM UP, in one process", async () => {
    const kp = devId();
    const light = devId();
    let level = 40;
    const ex = executors({
      getState: vi.fn(async () => ({ kind: "brightness", on: true, level }) as CapabilityState),
      command: vi.fn(async (_id, cmd) => { if (cmd.capability === "brightness" && cmd.action === "set") level = cmd.level ?? level; }),
    });
    const engine = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    const m = mapping({
      input: { keypadId: kp, control: "btn1", event: "hold_start" },
      actions: [],
      behavior: "alternate",
      target: { deviceId: light, capability: "brightness", step: 10 },
    });
    engine.setMappings([m]);

    await engine.onInputEvent(pressEvent(kp, "btn1", "hold_start"));
    expect(level).toBe(50); // 40 -> up -> 50
    await engine.onInputEvent(pressEvent(kp, "btn1", "hold_start"));
    expect(level).toBe(40); // 50 -> down -> 40
    await engine.onInputEvent(pressEvent(kp, "btn1", "hold_start"));
    expect(level).toBe(50); // 40 -> up -> 50
  });

  it("alternate: persists lastDirection through an injected persistBehaviorState hook (restart persistence)", async () => {
    const kp = devId();
    const light = devId();
    const ex = executors({ getState: vi.fn(async () => ({ kind: "brightness", on: true, level: 50 }) as CapabilityState) });
    const persisted: Record<string, unknown> = {};
    const engine = new KeypadMappingEngine({
      executors: ex,
      sleep: async () => {},
      persistBehaviorState: async (id, behaviorState) => { persisted[id] = behaviorState; },
    });
    const m = mapping({
      input: { keypadId: kp, control: "btn1", event: "hold_start" },
      actions: [],
      behavior: "alternate",
      target: { deviceId: light, capability: "brightness", step: 10 },
    });
    engine.setMappings([m]);

    await engine.onInputEvent(pressEvent(kp, "btn1", "hold_start"));
    expect(persisted[m.id]).toEqual({ lastDirection: "up", cycleIndex: 0 });

    await engine.onInputEvent(pressEvent(kp, "btn1", "hold_start"));
    expect(persisted[m.id]).toEqual({ lastDirection: "down", cycleIndex: 0 });

    // A "restart" — a brand-new engine, loading the mapping with the PERSISTED
    // behaviorState instead of a fresh default — resumes the alternation correctly.
    const restarted = KeypadMapping.parse({ ...m, behaviorState: persisted[m.id] });
    const engine2 = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    engine2.setMappings([restarted]);
    await engine2.onInputEvent(pressEvent(kp, "btn1", "hold_start"));
    expect(ex.command).toHaveBeenLastCalledWith(light, { capability: "brightness", action: "set", level: 60 }); // continues "up"
  });

  it("cycle: walks its actions one at a time per firing, wrapping around, persisting the index", async () => {
    const kp = devId();
    const sceneA = devId();
    const sceneB = devId();
    const ex = executors();
    const engine = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    const m = mapping({
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      behavior: "cycle",
      target: { deviceId: sceneA, capability: "onoff", step: 10 },
      actions: [
        { type: "device_command", deviceId: sceneA, command: { capability: "onoff", action: "on" } },
        { type: "device_command", deviceId: sceneB, command: { capability: "onoff", action: "on" } },
      ],
    });
    engine.setMappings([m]);

    await engine.onInputEvent(pressEvent(kp));
    expect(ex.command).toHaveBeenLastCalledWith(sceneA, { capability: "onoff", action: "on" });
    await engine.onInputEvent(pressEvent(kp));
    expect(ex.command).toHaveBeenLastCalledWith(sceneB, { capability: "onoff", action: "on" });
    await engine.onInputEvent(pressEvent(kp));
    expect(ex.command).toHaveBeenLastCalledWith(sceneA, { capability: "onoff", action: "on" }); // wraps
  });

  it("independent mappings per keypad/button/event: a Short Press toggle and a Long Press alternate on the SAME button never interfere", async () => {
    const kp = devId();
    const light = devId();
    let on = false;
    let level = 30;
    const ex = executors({
      getState: vi.fn(async (_id, cap) => (cap === "onoff" ? ({ kind: "onoff", on }) : ({ kind: "brightness", on, level })) as CapabilityState),
      command: vi.fn(async (_id, cmd) => {
        if (cmd.capability === "onoff") on = cmd.action === "on";
        if (cmd.capability === "brightness" && cmd.action === "set") level = cmd.level ?? level;
      }),
    });
    const engine = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    const shortPress = mapping({
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      actions: [],
      behavior: "toggle",
      target: { deviceId: light, capability: "onoff", step: 10 },
    });
    const longPress = mapping({
      input: { keypadId: kp, control: "btn1", event: "hold_start" },
      actions: [],
      behavior: "alternate",
      target: { deviceId: light, capability: "brightness", step: 10 },
    });
    engine.setMappings([shortPress, longPress]);

    await engine.onInputEvent(pressEvent(kp, "btn1", "short_press"));
    expect(on).toBe(true);
    expect(level).toBe(30); // untouched by the short-press toggle

    await engine.onInputEvent(pressEvent(kp, "btn1", "hold_start"));
    expect(level).toBe(40); // untouched-direction alternate independent of the toggle above
    expect(on).toBe(true); // untouched by the long-press alternate

    // Their behaviorState is per-mapping — verified via two independent recentRuns entries.
    expect(engine.recentRuns(shortPress.id)).toHaveLength(1);
    expect(engine.recentRuns(longPress.id)).toHaveLength(1);
  });

  it("§ multi-instance identity — two mappings for the same control/event on two DIFFERENT keypad deviceIds (e.g. two Casambi networks' Unit 4) never cross-fire", async () => {
    const kpNet1 = devId();
    const kpNet2 = devId();
    const lightNet1 = devId();
    const lightNet2 = devId();
    const ex = executors({ getState: vi.fn(async () => ({ kind: "onoff", on: false }) as CapabilityState) });
    const engine = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    const m1 = mapping({ input: { keypadId: kpNet1, control: "0", event: "short_press" }, actions: [], behavior: "toggle", target: { deviceId: lightNet1, capability: "onoff", step: 10 } });
    const m2 = mapping({ input: { keypadId: kpNet2, control: "0", event: "short_press" }, actions: [], behavior: "toggle", target: { deviceId: lightNet2, capability: "onoff", step: 10 } });
    engine.setMappings([m1, m2]);

    await engine.onInputEvent(pressEvent(kpNet1, "0", "short_press"));
    expect(ex.command).toHaveBeenCalledTimes(1);
    expect(ex.command).toHaveBeenCalledWith(lightNet1, { capability: "onoff", action: "on" });

    await engine.onInputEvent(pressEvent(kpNet2, "0", "short_press"));
    expect(ex.command).toHaveBeenCalledTimes(2);
    expect(ex.command).toHaveBeenCalledWith(lightNet2, { capability: "onoff", action: "on" });
  });

  it("a behavior mapping with no target is a validation error, never silently accepted", () => {
    expect(() =>
      mapping({ behavior: "toggle", target: null, actions: [] }),
    ).toThrow();
  });

  it("existing pre-Stage-2 \"direct\" mappings (the only shape that ever existed before) are completely unaffected", async () => {
    const kp = devId();
    const target = devId();
    const ex = executors();
    const engine = new KeypadMappingEngine({ executors: ex, sleep: async () => {} });
    // No `behavior` field at all — exactly what every mapping created before Stage 2 looks like.
    const m = KeypadMapping.parse({
      id: newId("keypadMapping"),
      homeId: homeId(),
      name: "Legacy direct mapping",
      input: { keypadId: kp, control: "btn1", event: "short_press" },
      actions: [{ type: "device_command", deviceId: target, command: { capability: "onoff", action: "toggle" } }],
    });
    expect(m.behavior).toBe("direct");
    engine.setMappings([m]);
    await engine.onInputEvent(pressEvent(kp));
    expect(ex.command).toHaveBeenCalledWith(target, { capability: "onoff", action: "toggle" });
  });
});
