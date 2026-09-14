import { describe, expect, it } from "vitest";
import { CapabilityCommand, CapabilityState, HvacStatus, TemperatureState } from "./capabilities.js";
import { newId } from "./ids.js";
import { DeviceId } from "./ids.js";

describe("ids", () => {
  it("generates prefixed ULID-style ids that validate", () => {
    const id = newId("device");
    expect(id.startsWith("dev_")).toBe(true);
    expect(() => DeviceId.parse(id)).not.toThrow();
  });

  it("sorts roughly by creation time", () => {
    const a = newId("device", 1_000_000_000_000);
    const b = newId("device", 2_000_000_000_000);
    expect(a < b).toBe(true);
  });
});

describe("capability commands", () => {
  it("accepts a brightness set command", () => {
    const cmd = CapabilityCommand.parse({
      capability: "brightness",
      action: "set",
      level: 60,
    });
    expect(cmd.capability).toBe("brightness");
  });

  it("rejects out-of-range brightness", () => {
    expect(() =>
      CapabilityCommand.parse({ capability: "brightness", action: "set", level: 140 }),
    ).toThrow();
  });
});

describe("capability state", () => {
  it("discriminates by kind", () => {
    const state = CapabilityState.parse({ kind: "brightness", on: true, level: 42 });
    expect(state.kind).toBe("brightness");
  });
});

describe("§ HVAC Domain-Model Correction — TemperatureState backward compatibility & new fields", () => {
  it("an existing (pre-correction) TemperatureState object, with none of the new fields, still parses exactly as before", () => {
    const state = TemperatureState.parse({ ambientC: 22, targetC: 20, mode: "heat" });
    expect(state).toEqual({ ambientC: 22, targetC: 20, mode: "heat" });
    expect(state.operatingMode).toBeUndefined();
    expect(state.controllingModeExtended).toBeUndefined();
    expect(state.heatCool).toBeUndefined();
    expect(state.status).toBeUndefined();
    expect(state.setpoints).toBeUndefined();
  });

  it("an existing CapabilityCommand temperature object, with none of the new fields, still parses exactly as before", () => {
    const cmd = CapabilityCommand.parse({ capability: "temperature", targetC: 21, mode: "cool" });
    expect(cmd).toEqual({ capability: "temperature", targetC: 21, mode: "cool" });
  });

  it("operatingMode (KNX DPT 20.102 concept) is distinct from mode (controlling mode) — both can be set independently", () => {
    const state = TemperatureState.parse({ ambientC: 22, targetC: 20, mode: "heat", operatingMode: "economy" });
    expect(state.mode).toBe("heat");
    expect(state.operatingMode).toBe("economy");
  });

  it("rejects an operatingMode value outside the canonical KNX DPT_HVACMode enumeration", () => {
    expect(() => TemperatureState.parse({ ambientC: 22, targetC: 20, mode: "heat", operatingMode: "eco" })).toThrow();
  });

  it("heatCool (KNX DPT 1.100 concept) is distinct from mode — a device can report both", () => {
    const state = TemperatureState.parse({ ambientC: 22, targetC: 20, mode: "auto", heatCool: "cool" });
    expect(state.mode).toBe("auto");
    expect(state.heatCool).toBe("cool");
  });

  it("controllingModeExtended carries a richer KNX DPT_HVACContrMode value alongside (never instead of) mode", () => {
    const state = TemperatureState.parse({ ambientC: 22, targetC: 20, mode: "heat", controllingModeExtended: "morning_warmup" });
    expect(state.mode).toBe("heat");
    expect(state.controllingModeExtended).toBe("morning_warmup");
  });

  it("structured HvacStatus preserves multiple independent status bits — never collapsed to one boolean", () => {
    const status = HvacStatus.parse({ fault: false, frostAlarm: true, overheatAlarm: false, heatingDisabled: true });
    expect(status).toEqual({ fault: false, frostAlarm: true, overheatAlarm: false, heatingDisabled: true });
    const state = TemperatureState.parse({ ambientC: 22, targetC: 20, mode: "heat", status });
    expect(state.status?.frostAlarm).toBe(true);
    expect(state.status?.heatingDisabled).toBe(true);
    expect(state.status?.overheatAlarm).toBe(false);
  });

  it("an empty HvacStatus (all fields omitted) is valid — a driver with only partial status feedback never needs to fabricate the rest", () => {
    expect(() => HvacStatus.parse({})).not.toThrow();
  });

  it("named preset setpoints (KNX DPT_TempRoomSetpSet family) can all be represented simultaneously, distinct from targetC", () => {
    const state = TemperatureState.parse({
      ambientC: 22,
      targetC: 21,
      mode: "heat",
      setpoints: { comfortC: 21, standbyC: 18, economyC: 16, buildingProtectionC: 7 },
    });
    expect(state.targetC).toBe(21);
    expect(state.setpoints).toEqual({ comfortC: 21, standbyC: 18, economyC: 16, buildingProtectionC: 7 });
  });

  it("a partial setpoints object (only some presets known) is valid — never fabricates the missing ones", () => {
    const state = TemperatureState.parse({ ambientC: 22, targetC: 21, mode: "heat", setpoints: { comfortC: 21 } });
    expect(state.setpoints).toEqual({ comfortC: 21 });
  });

  it("a temperature command can set operatingMode/heatCool independently of mode/targetC", () => {
    const cmd = CapabilityCommand.parse({ capability: "temperature", operatingMode: "standby" });
    expect(cmd).toMatchObject({ capability: "temperature", operatingMode: "standby" });
    const cmd2 = CapabilityCommand.parse({ capability: "temperature", heatCool: "heat" });
    expect(cmd2).toMatchObject({ capability: "temperature", heatCool: "heat" });
  });

  it("round-trips through JSON exactly (serialization compatibility)", () => {
    const original = TemperatureState.parse({
      ambientC: 22.5,
      targetC: 21,
      mode: "heat",
      operatingMode: "comfort",
      heatCool: "heat",
      status: { fault: false, frostAlarm: false },
      setpoints: { comfortC: 21, standbyC: 18 },
    });
    const roundTripped = TemperatureState.parse(JSON.parse(JSON.stringify(original)));
    expect(roundTripped).toEqual(original);
  });
});
