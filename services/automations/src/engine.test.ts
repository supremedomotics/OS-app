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

describe("engine selection", () => {
  it("native engine only runs enabled engine='supreme' automations", async () => {
    const ex = executors();
    const engine = new AutomationEngine({ executors: ex });
    const svc = new AutomationService(engine);
    await svc.start();
    const d = devId();
    await svc.create({
      homeId: homeId(),
      name: "Supreme-native",
      engine: "supreme",
      triggers: [{ type: "device_state", deviceId: d, capability: "onoff", field: "on", op: "changed" }],
      actions: [{ type: "device_command", deviceId: d, command: { capability: "onoff", action: "toggle" } }],
    });
    await svc.onDeviceState({ deviceId: d, capability: "onoff", state: { kind: "onoff", on: true } });
    expect(ex.command).toHaveBeenCalledTimes(1);
  });

  it("§ Native Backend Implementation — rejects creating a new engine='ha' automation instead of silently accepting-but-never-running it", async () => {
    const ex = executors();
    const engine = new AutomationEngine({ executors: ex });
    const svc = new AutomationService(engine);
    await svc.start();
    const d = devId();
    await expect(
      svc.create({
        homeId: homeId(),
        name: "HA-compiled",
        // @ts-expect-error — "ha" is intentionally not a valid CreateAutomationInput.engine
        // value; this exercises assertSupportedEngine()'s runtime guard for callers that
        // bypass the type system (e.g. a raw JSON request body).
        engine: "ha",
        triggers: [{ type: "device_state", deviceId: d, capability: "onoff", field: "on", op: "changed" }],
        actions: [{ type: "device_command", deviceId: d, command: { capability: "onoff", action: "toggle" } }],
      }),
    ).rejects.toThrow(/engine "ha" automations are not executable/);
  });

  it("rejects re-pointing an existing automation at engine='ha' via update", async () => {
    const ex = executors();
    const engine = new AutomationEngine({ executors: ex });
    const svc = new AutomationService(engine);
    await svc.start();
    const d = devId();
    const created = await svc.create({
      homeId: homeId(),
      name: "Native automation",
      triggers: [{ type: "interval", everyMinutes: 5 }],
      actions: [{ type: "notify", level: "info", title: "tick", body: "", userId: null }],
    });
    // @ts-expect-error — see the create() test above.
    await expect(svc.update(created.id, { engine: "ha" })).rejects.toThrow(/engine "ha" automations are not executable/);
  });

  it("native engine never executes a legacy, already-persisted engine='ha' row (a pre-fix row loaded from storage)", async () => {
    const ex = executors();
    const engine = new AutomationEngine({ executors: ex });
    const d = devId();
    // Bypasses the service layer's create()/update() guard on purpose — simulates a
    // row that predates HA's removal and is still sitting in a real database.
    engine.setAutomations([
      {
        id: newId("automation") as never,
        homeId: homeId(),
        name: "Legacy HA automation",
        enabled: true,
        // @ts-expect-error — see the create() test above.
        engine: "ha",
        triggers: [{ type: "device_state", deviceId: d, capability: "onoff", field: "on", op: "changed" }],
        conditions: [],
        actions: [{ type: "device_command", deviceId: d, command: { capability: "onoff", action: "toggle" } }],
        externalRef: null,
        aiGenerated: false,
        tags: [],
      },
    ]);
    await engine.onDeviceState({ deviceId: d, capability: "onoff", state: { kind: "onoff", on: true } });
    expect(ex.command).not.toHaveBeenCalled();
  });

  it("health() reports a legacy engine='ha' automation as broken — never silently 'healthy'/'waiting'", () => {
    const ex = executors();
    const engine = new AutomationEngine({ executors: ex });
    const d = devId();
    const legacy = {
      id: newId("automation") as never,
      homeId: homeId(),
      name: "Legacy HA automation",
      enabled: true,
      engine: "ha" as never,
      triggers: [{ type: "device_state", deviceId: d, capability: "onoff", field: "on", op: "changed" as const }],
      conditions: [],
      actions: [{ type: "device_command" as const, deviceId: d, command: { capability: "onoff" as const, action: "toggle" as const } }],
      externalRef: null,
      aiGenerated: false,
      tags: [],
    };
    const health = engine.health(legacy);
    expect(health.status).toBe("broken");
    expect(health.reason).toMatch(/Home Assistant/);
  });
});

describe("intent actions (§ Universal Intent & Capability Engine, Phase 2)", () => {
  it("dispatches an intent action through the injected runIntent executor", async () => {
    const runIntent = vi.fn(async () => {});
    const ex = executors({ runIntent });
    const engine = new AutomationEngine({ executors: ex, sleep: async () => {} });
    const svc = new AutomationService(engine);
    await svc.start();
    const d = devId();
    await svc.create({
      homeId: homeId(),
      name: "Intent-driven toggle",
      triggers: [{ type: "device_state", deviceId: d, capability: "onoff", field: "on", op: "changed" }],
      actions: [{ type: "intent", intentId: "toggleLight", target: { kind: "device", deviceId: d }, params: { step: 10 } }],
    });

    await svc.onDeviceState({ deviceId: d, capability: "onoff", state: { kind: "onoff", on: true } });

    expect(runIntent).toHaveBeenCalledWith("toggleLight", { kind: "device", deviceId: d }, { step: 10 });
  });

  it("throws a clear error when an intent action runs with no runIntent executor wired", async () => {
    const ex = executors(); // no runIntent
    const engine = new AutomationEngine({ executors: ex, sleep: async () => {} });
    const svc = new AutomationService(engine);
    await svc.start();
    const d = devId();
    await svc.create({
      homeId: homeId(),
      name: "Unwired intent",
      triggers: [{ type: "device_state", deviceId: d, capability: "onoff", field: "on", op: "changed" }],
      actions: [{ type: "intent", intentId: "toggleLight", target: { kind: "device", deviceId: d }, params: {} }],
    });

    await svc.onDeviceState({ deviceId: d, capability: "onoff", state: { kind: "onoff", on: true } });

    const runs = svc.recentRuns();
    expect(runs[0]!.ok).toBe(false);
    expect(runs[0]!.error).toMatch(/requires a wired Intent Engine/);
  });
});

describe("AutomationEngine — dry-run, health, duplicate (§ Phase 1)", () => {
  it("dry-run evaluates real conditions but never calls an executor", async () => {
    const lamp = devId();
    const guardDev = devId();
    const ex = executors({ getState: vi.fn(async () => ({ kind: "onoff", on: true }) as CapabilityState) });
    const engine = new AutomationEngine({ executors: ex, sleep: async () => {} });
    const svc = new AutomationService(engine);
    await svc.start();

    const a = await svc.create({
      homeId: homeId(),
      name: "Dry run test",
      triggers: [{ type: "time", at: "07:00", days: [] }],
      conditions: [{ type: "device_state", deviceId: guardDev, capability: "onoff", field: "on", op: "eq", value: true }],
      actions: [{ type: "device_command", deviceId: lamp, command: { capability: "onoff", action: "on" } }],
    });

    const run = await svc.dryRun(a.id);
    expect(run.trigger).toBe("dry_run");
    expect(run.conditionsPassed).toBe(true);
    expect(run.actions[0]?.summary).toMatch(/^Would run:/);
    expect(ex.command).not.toHaveBeenCalled(); // no real side effect

    // Dry-run is recorded into the same history the debugger reads.
    expect(svc.recentRuns(a.id).some((r) => r.trigger === "dry_run")).toBe(true);
  });

  it("dry-run reports a failed condition exactly like a real run, still with no side effect", async () => {
    const guardDev = devId();
    const ex = executors({ getState: vi.fn(async () => ({ kind: "onoff", on: false }) as CapabilityState) });
    const engine = new AutomationEngine({ executors: ex, sleep: async () => {} });
    const svc = new AutomationService(engine);
    await svc.start();

    const a = await svc.create({
      homeId: homeId(),
      name: "Dry run blocked",
      triggers: [{ type: "time", at: "07:00", days: [] }],
      conditions: [{ type: "device_state", deviceId: guardDev, capability: "onoff", field: "on", op: "eq", value: true }],
      actions: [{ type: "device_command", deviceId: devId(), command: { capability: "onoff", action: "on" } }],
    });

    const run = await svc.dryRun(a.id);
    expect(run.conditionsPassed).toBe(false);
    expect(run.failedCondition).toBeTruthy();
    expect(run.actions).toHaveLength(0);
  });

  it("health reflects disabled / waiting / healthy / broken from real run history", async () => {
    const ex = executors({ command: vi.fn(async () => { throw new Error("device offline"); }) });
    const engine = new AutomationEngine({ executors: ex, sleep: async () => {} });
    const svc = new AutomationService(engine);
    await svc.start();

    const a = await svc.create({
      homeId: homeId(),
      name: "Health test",
      enabled: false,
      triggers: [{ type: "time", at: "07:00", days: [] }],
      actions: [{ type: "device_command", deviceId: devId(), command: { capability: "onoff", action: "on" } }],
    });
    expect((await svc.health(a.id)).status).toBe("disabled");

    const enabled = await svc.update(a.id, { enabled: true });
    expect((await svc.health(enabled.id)).status).toBe("waiting"); // no runs yet

    await svc.testRun(enabled.id); // manual run skips conditions, action throws
    const health = await svc.health(enabled.id);
    expect(health.status).toBe("broken");
    expect(health.reason).toContain("device offline");
  });

  it("a dry-run never masks a real failure in Health — dry-runs are excluded from the health computation entirely", async () => {
    const ex = executors({ command: vi.fn(async () => { throw new Error("bus offline"); }) });
    const engine = new AutomationEngine({ executors: ex, sleep: async () => {} });
    const svc = new AutomationService(engine);
    await svc.start();

    const a = await svc.create({
      homeId: homeId(),
      name: "Real failure then a passing dry-run",
      triggers: [{ type: "time", at: "07:00", days: [] }],
      actions: [{ type: "device_command", deviceId: devId(), command: { capability: "onoff", action: "on" } }],
    });

    await svc.testRun(a.id); // real run — fails (bus offline)
    expect((await svc.health(a.id)).status).toBe("broken");

    // A dry-run's action is recorded "ok" (synthetic, never really executed) — it must NOT
    // overwrite the genuinely broken status just because it's now the most recent history entry.
    await svc.dryRun(a.id);
    const health = await svc.health(a.id);
    expect(health.status).toBe("broken");
    expect(health.reason).toContain("bus offline");
  });

  it("duplicate clones an automation, disabled by default, never firing alongside the original unreviewed", async () => {
    const ex = executors();
    const engine = new AutomationEngine({ executors: ex, sleep: async () => {} });
    const svc = new AutomationService(engine);
    await svc.start();

    const original = await svc.create({
      homeId: homeId(),
      name: "Original",
      enabled: true,
      triggers: [{ type: "time", at: "07:00", days: [] }],
      actions: [{ type: "device_command", deviceId: devId(), command: { capability: "onoff", action: "on" } }],
    });

    const copy = await svc.duplicate(original.id);
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe("Original (copy)");
    expect(copy.enabled).toBe(false);
    expect(copy.triggers).toEqual(original.triggers);
    expect(copy.actions).toEqual(original.actions);

    const all = await svc.list();
    expect(all).toHaveLength(2);
  });
});
