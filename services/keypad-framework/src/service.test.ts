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
