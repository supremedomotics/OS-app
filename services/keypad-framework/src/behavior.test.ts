import { newId, type CapabilityState, type DeviceId, type KeypadMappingTarget } from "@supreme/domain-model";
import type { AutomationExecutors } from "@supreme/automations";
import { describe, expect, it, vi } from "vitest";
import { resolveBehaviorCommand } from "./behavior.js";

function executors(getState: AutomationExecutors["getState"]): AutomationExecutors {
  return { command: vi.fn(async () => {}), activateScene: vi.fn(async () => {}), notify: vi.fn(async () => {}), getState };
}

const devId = () => newId("device") as DeviceId;

describe("resolveBehaviorCommand — toggle (§ Supreme Universal Keypad, Stage 2)", () => {
  it("Light OFF -> Short Press -> ON, reading live state, never a locally remembered boolean", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "onoff", step: 10 };
    const ex = executors(vi.fn(async () => ({ kind: "onoff", on: false }) as CapabilityState));
    const { command } = await resolveBehaviorCommand(ex, { behavior: "toggle", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    expect(command).toEqual({ capability: "onoff", action: "on" });
  });

  it("ON -> Short Press -> OFF", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "onoff", step: 10 };
    const ex = executors(vi.fn(async () => ({ kind: "onoff", on: true }) as CapabilityState));
    const { command } = await resolveBehaviorCommand(ex, { behavior: "toggle", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    expect(command).toEqual({ capability: "onoff", action: "off" });
  });

  it("an EXTERNAL interface turning the light OFF is honored on the very next press — no stale local state", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "onoff", step: 10 };
    let externallyOn = true;
    const getState = vi.fn(async () => ({ kind: "onoff", on: externallyOn }) as CapabilityState);
    const ex = executors(getState);
    const bs = { lastDirection: null, cycleIndex: 0 } as const;

    // Keypad press #1: light is ON (from the driver's live state) -> resolves OFF.
    expect((await resolveBehaviorCommand(ex, { behavior: "toggle", target, behaviorState: bs })).command).toEqual({ capability: "onoff", action: "off" });

    // Someone else's interface turns it back ON, bypassing the keypad entirely.
    externallyOn = true;

    // Keypad press #2 must see that real change, not "what the keypad itself last sent".
    expect((await resolveBehaviorCommand(ex, { behavior: "toggle", target, behaviorState: bs })).command).toEqual({ capability: "onoff", action: "off" });
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it("no state yet (never reported) defaults to OFF -> resolves ON, never throws", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "onoff", step: 10 };
    const ex = executors(vi.fn(async () => null));
    const { command } = await resolveBehaviorCommand(ex, { behavior: "toggle", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    expect(command).toEqual({ capability: "onoff", action: "on" });
  });

  it("rejects a capability toggle has no honest on/off reading for (e.g. media) rather than guessing", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "media", step: 10 };
    const ex = executors(vi.fn(async () => null));
    await expect(resolveBehaviorCommand(ex, { behavior: "toggle", target, behaviorState: { lastDirection: null, cycleIndex: 0 } })).rejects.toThrow(/not supported/);
  });
});

describe("resolveBehaviorCommand — alternate (§ Supreme Universal Keypad, Stage 2)", () => {
  it("First Long Press -> DIM UP (from a null lastDirection)", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "brightness", step: 10 };
    const ex = executors(vi.fn(async () => ({ kind: "brightness", on: true, level: 40 }) as CapabilityState));
    const r = await resolveBehaviorCommand(ex, { behavior: "alternate", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    expect(r.command).toEqual({ capability: "brightness", action: "set", level: 50 });
    expect(r.nextBehaviorState?.lastDirection).toBe("up");
  });

  it("UP -> DOWN -> UP -> DOWN, alternating on every firing, driven by the persisted lastDirection", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "brightness", step: 10 };
    const ex = executors(vi.fn(async () => ({ kind: "brightness", on: true, level: 50 }) as CapabilityState));
    let bs = { lastDirection: null as "up" | "down" | null, cycleIndex: 0 };

    const r1 = await resolveBehaviorCommand(ex, { behavior: "alternate", target, behaviorState: bs });
    expect(r1.nextBehaviorState?.lastDirection).toBe("up");
    bs = r1.nextBehaviorState!;

    const r2 = await resolveBehaviorCommand(ex, { behavior: "alternate", target, behaviorState: bs });
    expect(r2.nextBehaviorState?.lastDirection).toBe("down");
    bs = r2.nextBehaviorState!;

    const r3 = await resolveBehaviorCommand(ex, { behavior: "alternate", target, behaviorState: bs });
    expect(r3.nextBehaviorState?.lastDirection).toBe("up");
    bs = r3.nextBehaviorState!;

    const r4 = await resolveBehaviorCommand(ex, { behavior: "alternate", target, behaviorState: bs });
    expect(r4.nextBehaviorState?.lastDirection).toBe("down");
  });

  it("clamps at 100 / 0 rather than overshooting", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "brightness", step: 10 };
    const exHigh = executors(vi.fn(async () => ({ kind: "brightness", on: true, level: 95 }) as CapabilityState));
    const up = await resolveBehaviorCommand(exHigh, { behavior: "alternate", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    expect(up.command).toEqual({ capability: "brightness", action: "set", level: 100 });

    const exLow = executors(vi.fn(async () => ({ kind: "brightness", on: true, level: 5 }) as CapabilityState));
    const down = await resolveBehaviorCommand(exLow, { behavior: "alternate", target, behaviorState: { lastDirection: "up", cycleIndex: 0 } });
    expect(down.command).toEqual({ capability: "brightness", action: "set", level: 0 });
  });

  it("resumes from a RESTORED lastDirection exactly where it left off (restart persistence)", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "brightness", step: 10 };
    const ex = executors(vi.fn(async () => ({ kind: "brightness", on: true, level: 50 }) as CapabilityState));
    // Simulates loading a mapping whose PERSISTED behaviorState says the last real firing went "up".
    const r = await resolveBehaviorCommand(ex, { behavior: "alternate", target, behaviorState: { lastDirection: "up", cycleIndex: 0 } });
    expect(r.nextBehaviorState?.lastDirection).toBe("down");
  });
});

describe("resolveBehaviorCommand — increment / decrement", () => {
  it("increment always steps up, never alternates", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "brightness", step: 15 };
    const ex = executors(vi.fn(async () => ({ kind: "brightness", on: true, level: 20 }) as CapabilityState));
    const r1 = await resolveBehaviorCommand(ex, { behavior: "increment", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    const r2 = await resolveBehaviorCommand(ex, { behavior: "increment", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    expect(r1.command).toEqual({ capability: "brightness", action: "set", level: 35 });
    expect(r2.command).toEqual({ capability: "brightness", action: "set", level: 35 });
    expect(r1.nextBehaviorState).toBeUndefined();
  });

  it("decrement always steps down, on a position capability too", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "position", step: 20 };
    const ex = executors(vi.fn(async () => ({ kind: "position", position: 50, moving: false }) as CapabilityState));
    const r = await resolveBehaviorCommand(ex, { behavior: "decrement", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    expect(r.command).toEqual({ capability: "position", action: "set", position: 30 });
  });
});

describe("resolveBehaviorCommand — dim speed (§ Keypad dim-speed)", () => {
  it("increment merges target.fadeMs onto the resolved brightness command", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "brightness", step: 15, fadeMs: 10_000 };
    const ex = executors(vi.fn(async () => ({ kind: "brightness", on: true, level: 20 }) as CapabilityState));
    const r = await resolveBehaviorCommand(ex, { behavior: "increment", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    expect(r.command).toEqual({ capability: "brightness", action: "set", level: 35, fadeMs: 10_000 });
  });

  it("decrement merges target.fadeMs too", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "brightness", step: 15, fadeMs: 5_000 };
    const ex = executors(vi.fn(async () => ({ kind: "brightness", on: true, level: 50 }) as CapabilityState));
    const r = await resolveBehaviorCommand(ex, { behavior: "decrement", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    expect(r.command).toEqual({ capability: "brightness", action: "set", level: 35, fadeMs: 5_000 });
  });

  it("alternate merges target.fadeMs too", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "brightness", step: 10, fadeMs: 2_000 };
    const ex = executors(vi.fn(async () => ({ kind: "brightness", on: true, level: 50 }) as CapabilityState));
    const r = await resolveBehaviorCommand(ex, { behavior: "alternate", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    expect(r.command).toEqual({ capability: "brightness", action: "set", level: 60, fadeMs: 2_000 });
  });

  it("no fadeMs on target -> no fadeMs field on the command at all (not even undefined) — instant, unchanged from every mapping created before this field existed", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "brightness", step: 15 };
    const ex = executors(vi.fn(async () => ({ kind: "brightness", on: true, level: 20 }) as CapabilityState));
    const r = await resolveBehaviorCommand(ex, { behavior: "increment", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    expect(r.command).toEqual({ capability: "brightness", action: "set", level: 35 });
    expect(r.command).not.toHaveProperty("fadeMs");
  });

  it("fadeMs is meaningless (simply unused) for position — no fadeMs field ever appears on a position command", async () => {
    const target: KeypadMappingTarget = { deviceId: devId(), capability: "position", step: 20, fadeMs: 10_000 };
    const ex = executors(vi.fn(async () => ({ kind: "position", position: 50, moving: false }) as CapabilityState));
    const r = await resolveBehaviorCommand(ex, { behavior: "decrement", target, behaviorState: { lastDirection: null, cycleIndex: 0 } });
    expect(r.command).toEqual({ capability: "position", action: "set", position: 30 });
  });
});
