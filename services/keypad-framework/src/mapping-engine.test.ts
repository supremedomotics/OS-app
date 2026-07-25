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
