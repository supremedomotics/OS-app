import {
  newId,
  type CapabilityState,
  type DeviceId,
  type HomeId,
  type SceneId,
} from "@supreme/domain-model";
import { describe, expect, it, vi } from "vitest";
import { AutomationEngine, type AutomationExecutors } from "./engine.js";
import { AutomationService } from "./service.js";
import { compileToHa } from "./compiler.js";

function executors(overrides: Partial<AutomationExecutors> = {}) {
  return {
    command: vi.fn(async () => {}),
    activateScene: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    getState: vi.fn(async () => null),
    ...overrides,
  } satisfies AutomationExecutors;
}

const homeId = () => newId("home") as HomeId;
const devId = () => newId("device") as DeviceId;

describe("AutomationEngine — device_state triggers", () => {
  it("runs actions when a motion/brightness threshold is crossed and conditions pass", async () => {
    const ex = executors();
    const engine = new AutomationEngine({ executors: ex, sleep: async () => {} });
    const svc = new AutomationService(engine);
    await svc.start();

    const motion = devId();
    const lamp = devId();
    await svc.create({
      homeId: homeId(),
      name: "Lamp on bright drop",
      triggers: [{ type: "device_state", deviceId: motion, capability: "sensor", field: "value", op: "lt", value: 100 }],
      actions: [{ type: "device_command", deviceId: lamp, command: { capability: "onoff", action: "on" } }],
    });

    // Below threshold → fires.
    await svc.onDeviceState({
      deviceId: motion,
      capability: "sensor",
      state: { kind: "sensor", value: 40, unit: "lx", measure: "illuminance" } as CapabilityState,
    });
    expect(ex.command).toHaveBeenCalledTimes(1);

    // Above threshold → does not fire.
    await svc.onDeviceState({
      deviceId: motion,
      capability: "sensor",
      state: { kind: "sensor", value: 300, unit: "lx", measure: "illuminance" } as CapabilityState,
    });
    expect(ex.command).toHaveBeenCalledTimes(1);
  });

  it("blocks actions when a condition is not met", async () => {
    const guard = devId();
    const ex = executors({
      getState: vi.fn(async () => ({ kind: "onoff", on: false }) as CapabilityState),
    });
    const engine = new AutomationEngine({ executors: ex, sleep: async () => {} });
    const svc = new AutomationService(engine);
    await svc.start();

    const sensor = devId();
    await svc.create({
      homeId: homeId(),
      name: "Only when armed",
      triggers: [{ type: "device_state", deviceId: sensor, capability: "onoff", field: "on", op: "eq", value: true }],
      conditions: [{ type: "device_state", deviceId: guard, capability: "onoff", field: "on", op: "eq", value: true }],
      actions: [{ type: "notify", level: "warning", title: "Motion", body: "Detected", userId: null }],
    });

    await svc.onDeviceState({ deviceId: sensor, capability: "onoff", state: { kind: "onoff", on: true } });
    expect(ex.notify).not.toHaveBeenCalled(); // guard is off → condition fails

    // The Debugger trace records WHY it didn't run (the failing condition).
    const blocked = svc.recentRuns()[0]!;
    expect(blocked.trigger).toBe("device_state");
    expect(blocked.conditionsPassed).toBe(false);
    expect(blocked.failedCondition).toContain("onoff");
    expect(blocked.actions).toHaveLength(0);
    expect(blocked.ok).toBe(false);
  });

  it("records a per-action execution trace incl. failures (§ Automation Debugger)", async () => {
    const lamp = devId();
    const ex = executors({
      command: vi.fn(async () => { throw new Error("device offline"); }),
    });
    const engine = new AutomationEngine({ executors: ex, sleep: async () => {} });
    const svc = new AutomationService(engine);
    await svc.start();

    const motion = devId();
    const auto = await svc.create({
      homeId: homeId(),
      name: "Lamp on motion",
      triggers: [{ type: "device_state", deviceId: motion, capability: "onoff", field: "on", op: "eq", value: true }],
      actions: [{ type: "device_command", deviceId: lamp, command: { capability: "onoff", action: "on" } }],
    });

    await svc.onDeviceState({ deviceId: motion, capability: "onoff", state: { kind: "onoff", on: true } });

    const run = svc.recentRuns(auto.id)[0]!;
    expect(run.trigger).toBe("device_state");
    expect(run.conditionsPassed).toBe(true);
    expect(run.actions).toHaveLength(1);
    expect(run.actions[0]!.ok).toBe(false);
    expect(run.actions[0]!.error).toContain("device offline");
    expect(run.actions[0]!.summary).toContain("Command onoff");
    expect(run.ok).toBe(false);
    expect(run.error).toContain("device offline");
  });
});

describe("AutomationEngine — time & interval triggers", () => {
  it("fires a time trigger once at the matching minute", async () => {
    const ex = executors();
    const engine = new AutomationEngine({ executors: ex, sleep: async () => {} });
    const svc = new AutomationService(engine);
    await svc.start();
    const scene = newId("scene") as SceneId;
    await svc.create({
      homeId: homeId(),
      name: "Goodnight at 23:00",
      triggers: [{ type: "time", at: "23:00", days: [] }],
      actions: [{ type: "scene_activate", sceneId: scene }],
    });

    const at2300 = new Date("2026-06-04T23:00:30");
    await svc.tick(at2300);
    await svc.tick(at2300); // same minute → no double fire
    expect(ex.activateScene).toHaveBeenCalledTimes(1);

    await svc.tick(new Date("2026-06-04T23:01:00")); // different minute, not 23:00
    expect(ex.activateScene).toHaveBeenCalledTimes(1);
  });

  it("fires an interval trigger every N minutes", async () => {
    const ex = executors();
    const engine = new AutomationEngine({ executors: ex, sleep: async () => {} });
    const svc = new AutomationService(engine);
    await svc.start();
    await svc.create({
      homeId: homeId(),
      name: "Every 5 minutes",
      triggers: [{ type: "interval", everyMinutes: 5 }],
      actions: [{ type: "notify", level: "info", title: "tick", body: "", userId: null }],
    });
    const base = new Date("2026-06-04T08:00:00").getTime();
    await svc.tick(new Date(base)); // first fire
    await svc.tick(new Date(base + 2 * 60_000)); // +2m, no
    await svc.tick(new Date(base + 5 * 60_000)); // +5m, fire
    expect(ex.notify).toHaveBeenCalledTimes(2);
  });
});

describe("engine selection + HA compile", () => {
  it("native engine ignores engine='ha' automations", async () => {
    const ex = executors();
    const engine = new AutomationEngine({ executors: ex });
    const svc = new AutomationService(engine);
    await svc.start();
    const d = devId();
    await svc.create({
      homeId: homeId(),
      name: "HA-compiled",
      engine: "ha",
      triggers: [{ type: "device_state", deviceId: d, capability: "onoff", field: "on", op: "changed" }],
      actions: [{ type: "device_command", deviceId: d, command: { capability: "onoff", action: "toggle" } }],
    });
    await svc.onDeviceState({ deviceId: d, capability: "onoff", state: { kind: "onoff", on: true } });
    expect(ex.command).not.toHaveBeenCalled();
  });

  it("compiles a Supreme automation to an HA config shape", () => {
    const d = devId();
    const config = compileToHa({
      id: newId("automation") as never,
      homeId: homeId(),
      name: "x",
      enabled: true,
      triggers: [{ type: "time", at: "07:00", days: [] }],
      conditions: [],
      actions: [{ type: "device_command", deviceId: d, command: { capability: "onoff", action: "on" } }],
      engine: "ha",
      externalRef: null,
      aiGenerated: false,
    });
    expect(config.trigger[0]).toMatchObject({ platform: "time", at: "07:00" });
    expect(config.action[0]).toMatchObject({ service: "supreme.command" });
  });
});
