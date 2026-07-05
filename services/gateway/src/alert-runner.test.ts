import { describe, expect, it } from "vitest";
import { alertConditionMet, AlertRuleError, AlertRuleRunner, validateAlertRule } from "./alert-runner.js";

describe("alertConditionMet", () => {
  it("evaluates each rule type against the device state", () => {
    expect(alertConditionMet("left_on", { onoff: { on: true } })).toBe(true);
    expect(alertConditionMet("left_on", { onoff: { on: false } })).toBe(false);
    expect(alertConditionMet("left_open", { position: { position: 40 } })).toBe(true);
    expect(alertConditionMet("left_open", { position: { position: 0 } })).toBe(false);
    expect(alertConditionMet("left_unlocked", { lock: { locked: false } })).toBe(true);
    expect(alertConditionMet("left_unlocked", { lock: { locked: true } })).toBe(false);
    expect(alertConditionMet("left_on", undefined)).toBe(false);
  });
});

describe("validateAlertRule", () => {
  it("accepts valid rules and rejects bad ones", () => {
    expect(validateAlertRule({ deviceId: "d", type: "left_open", durationMinutes: 10 }).id).toBe("alert_d_left_open");
    expect(() => validateAlertRule({ type: "left_open", durationMinutes: 10 })).toThrow(AlertRuleError);
    expect(() => validateAlertRule({ deviceId: "d", type: "nope", durationMinutes: 10 })).toThrow(/left_on/);
    expect(() => validateAlertRule({ deviceId: "d", type: "left_open", durationMinutes: 0 })).toThrow(/durationMinutes/);
  });
});

describe("AlertRuleRunner", () => {
  it("fires once after the duration is exceeded, and resets when the condition clears", async () => {
    const notes: string[] = [];
    let clock = 0;
    let open = true;
    const runner = new AlertRuleRunner({
      getRules: async () => [{ id: "r", deviceId: "door", type: "left_open", durationMinutes: 10 }],
      getDevice: async () => ({ name: "Front Door", state: { position: { position: open ? 80 : 0 } } }),
      notify: async (m) => void notes.push(m),
      now: () => clock,
    });

    clock = 0;
    await runner.tick(); // starts the episode
    expect(notes).toEqual([]);
    clock = 5 * 60_000;
    await runner.tick(); // 5 min — not yet
    expect(notes).toEqual([]);
    clock = 10 * 60_000;
    await runner.tick(); // 10 min — fire
    expect(notes).toEqual(["Front Door has been left open"]);
    clock = 15 * 60_000;
    await runner.tick(); // still open — don't re-fire this episode
    expect(notes).toHaveLength(1);

    open = false; // door closed → reset
    clock = 16 * 60_000;
    await runner.tick();
    open = true; // re-opened → new episode
    clock = 16 * 60_000 + 60_000;
    await runner.tick(); // episode restarts
    clock = 16 * 60_000 + 11 * 60_000;
    await runner.tick(); // 10+ min into the new episode → fire again
    expect(notes).toHaveLength(2);
  });

  it("uses a custom message when provided", async () => {
    const notes: string[] = [];
    let clock = 0;
    const runner = new AlertRuleRunner({
      getRules: async () => [{ id: "r", deviceId: "garage", type: "left_open", durationMinutes: 1, message: "Garage door open!" }],
      getDevice: async () => ({ name: "Garage", state: { position: { position: 100 } } }),
      notify: async (m) => void notes.push(m),
      now: () => clock,
    });
    await runner.tick();
    clock = 60_000;
    await runner.tick();
    expect(notes).toEqual(["Garage door open!"]);
  });
});
