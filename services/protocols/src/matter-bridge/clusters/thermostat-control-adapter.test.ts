import { describe, expect, it } from "vitest";
import { Thermostat } from "@matter/main/clusters/thermostat";
import {
  celsiusToMatter,
  confirmedHeatCoolDirection,
  matterToCelsius,
  supremeModeFromSystemMode,
  systemModeFromSupremeMode,
  temperatureCommandForSetpoint,
  temperatureCommandForSystemMode,
} from "./thermostat-control-adapter.js";

describe("thermostat-control-adapter — § Matter Bridge Phase 3.2 pure value translation", () => {
  it("celsius <-> Matter hundredths round-trips losslessly to 0.01C", () => {
    expect(celsiusToMatter(22)).toBe(2200);
    expect(celsiusToMatter(20.5)).toBe(2050);
    expect(matterToCelsius(2200)).toBe(22);
    expect(matterToCelsius(2050)).toBe(20.5);
  });

  it("systemModeFromSupremeMode maps every non-auto SupremeOS mode to its real Matter SystemMode", () => {
    expect(systemModeFromSupremeMode("off")).toBe(Thermostat.SystemMode.Off);
    expect(systemModeFromSupremeMode("heat")).toBe(Thermostat.SystemMode.Heat);
    expect(systemModeFromSupremeMode("cool")).toBe(Thermostat.SystemMode.Cool);
    expect(systemModeFromSupremeMode("fan_only")).toBe(Thermostat.SystemMode.FanOnly);
  });

  it("§ Phase 3.1.1 hard rule — 'auto' NEVER maps to SystemMode.Auto; returns null (do not write the attribute)", () => {
    expect(systemModeFromSupremeMode("auto")).toBeNull();
    expect(systemModeFromSupremeMode("auto")).not.toBe(Thermostat.SystemMode.Auto);
  });

  it("supremeModeFromSystemMode is the exact inverse for every mode this endpoint's feature set can legally hold", () => {
    expect(supremeModeFromSystemMode(Thermostat.SystemMode.Off)).toBe("off");
    expect(supremeModeFromSystemMode(Thermostat.SystemMode.Heat)).toBe("heat");
    expect(supremeModeFromSystemMode(Thermostat.SystemMode.Cool)).toBe("cool");
    expect(supremeModeFromSystemMode(Thermostat.SystemMode.FanOnly)).toBe("fan_only");
  });

  it("supremeModeFromSystemMode returns null (never a fabricated fallback) for Auto or any other unsupported value", () => {
    expect(supremeModeFromSystemMode(Thermostat.SystemMode.Auto)).toBeNull();
    expect(supremeModeFromSystemMode(Thermostat.SystemMode.Dry)).toBeNull();
    expect(supremeModeFromSystemMode(Thermostat.SystemMode.Sleep)).toBeNull();
  });

  it("temperatureCommandForSystemMode builds a real temperature capability command, or null for an untranslatable mode", () => {
    expect(temperatureCommandForSystemMode(Thermostat.SystemMode.Off)).toEqual({ capability: "temperature", mode: "off" });
    expect(temperatureCommandForSystemMode(Thermostat.SystemMode.Auto)).toBeNull();
  });

  // § Phase 3.4A/3.4B — Heat/Cool route through `heatCool` (DPT 1.100's genuine, writable KNX
  // destination), NOT `mode`. `mode` has no writable KNX destination at all (3.3D-FIX correctly
  // rejects a mode-only KNX command); `heatCool` does, with real feedback and confirmed-state
  // authority already implemented in `KnxProtocolDriver.command()`, unmodified by this fix.
  it("1 — Matter Heat produces {heatCool:\"heat\"}, never {mode:\"heat\"}", () => {
    const command = temperatureCommandForSystemMode(Thermostat.SystemMode.Heat);
    expect(command).toEqual({ capability: "temperature", heatCool: "heat" });
    expect(command).not.toHaveProperty("mode");
    expect(command).not.toHaveProperty("targetC");
    expect(command).not.toHaveProperty("operatingMode");
  });

  it("2 — Matter Cool produces {heatCool:\"cool\"}, never {mode:\"cool\"}", () => {
    const command = temperatureCommandForSystemMode(Thermostat.SystemMode.Cool);
    expect(command).toEqual({ capability: "temperature", heatCool: "cool" });
    expect(command).not.toHaveProperty("mode");
    expect(command).not.toHaveProperty("targetC");
    expect(command).not.toHaveProperty("operatingMode");
  });

  it("6 — Off regression: still produces only {mode:\"off\"} — never heatCool, operatingMode, controllingModeExtended, or targetC (Phase 3.4A: no honest KNX destination exists for Off)", () => {
    const command = temperatureCommandForSystemMode(Thermostat.SystemMode.Off);
    expect(command).toEqual({ capability: "temperature", mode: "off" });
    expect(command).not.toHaveProperty("heatCool");
    expect(command).not.toHaveProperty("operatingMode");
    expect(command).not.toHaveProperty("controllingModeExtended");
    expect(command).not.toHaveProperty("targetC");
  });

  it("7 — FanOnly regression: still produces only {mode:\"fan_only\"} — never heatCool, operatingMode, controllingModeExtended, fanSpeed, or targetC (Phase 3.4A: no honest KNX destination exists for FanOnly)", () => {
    const command = temperatureCommandForSystemMode(Thermostat.SystemMode.FanOnly);
    expect(command).toEqual({ capability: "temperature", mode: "fan_only" });
    expect(command).not.toHaveProperty("heatCool");
    expect(command).not.toHaveProperty("operatingMode");
    expect(command).not.toHaveProperty("controllingModeExtended");
    expect(command).not.toHaveProperty("fanSpeed");
    expect(command).not.toHaveProperty("targetC");
  });

  it("temperatureCommandForSetpoint always maps onto the single targetC field, never a separate heat/cool target", () => {
    expect(temperatureCommandForSetpoint(2000)).toEqual({ capability: "temperature", targetC: 20 });
    expect(temperatureCommandForSetpoint(2500)).toEqual({ capability: "temperature", targetC: 25 });
  });
});

describe("confirmedHeatCoolDirection — § Phase 3.4C Matter Thermostat KNX heatCool read-back", () => {
  it("1 — heatCool='heat' reports Heat regardless of mode", () => {
    expect(confirmedHeatCoolDirection({ mode: "auto", heatCool: "heat" })).toBe("heat");
    expect(systemModeFromSupremeMode(confirmedHeatCoolDirection({ mode: "auto", heatCool: "heat" }))).toBe(Thermostat.SystemMode.Heat);
  });

  it("2 — heatCool='cool' reports Cool regardless of mode", () => {
    expect(confirmedHeatCoolDirection({ mode: "auto", heatCool: "cool" })).toBe("cool");
    expect(systemModeFromSupremeMode(confirmedHeatCoolDirection({ mode: "auto", heatCool: "cool" }))).toBe(Thermostat.SystemMode.Cool);
  });

  it("4 — heatCool=null/undefined falls back to mode — the existing, unmodified pre-Phase-3.4C behavior, never a fabricated fallback", () => {
    expect(confirmedHeatCoolDirection({ mode: "heat", heatCool: null })).toBe("heat");
    expect(confirmedHeatCoolDirection({ mode: "cool", heatCool: undefined })).toBe("cool");
    expect(confirmedHeatCoolDirection({ mode: "off", heatCool: null })).toBe("off");
    expect(confirmedHeatCoolDirection({ mode: "auto" })).toBe("auto");
  });

  it("5 — mode='auto' + heatCool='heat' reports Heat, never Auto (Matter AutoMode stays disabled)", () => {
    const direction = confirmedHeatCoolDirection({ mode: "auto", heatCool: "heat" });
    expect(direction).toBe("heat");
    expect(systemModeFromSupremeMode(direction)).not.toBe(Thermostat.SystemMode.Auto);
    expect(systemModeFromSupremeMode(direction)).toBe(Thermostat.SystemMode.Heat);
  });

  it("6 — mode='auto' + heatCool='cool' reports Cool", () => {
    const direction = confirmedHeatCoolDirection({ mode: "auto", heatCool: "cool" });
    expect(direction).toBe("cool");
    expect(systemModeFromSupremeMode(direction)).toBe(Thermostat.SystemMode.Cool);
  });

  it("7 — heatCool can never produce Off — its type is heat|cool only; Off only ever comes from mode when heatCool is absent", () => {
    expect(confirmedHeatCoolDirection({ mode: "off", heatCool: null })).toBe("off");
    // There is no heatCool value that could ever route here — this documents that DPT 1.100
    // (two values only) structurally cannot fabricate Off, not merely that this test forgot to try.
    expect(["heat", "cool"]).not.toContain("off");
  });

  it("8 — controllingModeExtended is not a parameter of this function at all — it cannot influence the result, so 'fan_only' from controllingModeExtended can never reach Matter FanOnly through this path", () => {
    // confirmedHeatCoolDirection's own type signature has no controllingModeExtended field —
    // this is a compile-time guarantee, not just a runtime check. mode='fan_only' with no
    // heatCool still correctly reports fan_only (unchanged pre-3.4C behavior), which
    // systemModeFromSupremeMode maps to Thermostat.SystemMode.FanOnly — the SAME behavior
    // as before this phase, never a NEW FanOnly path via controllingModeExtended.
    expect(confirmedHeatCoolDirection({ mode: "fan_only", heatCool: null })).toBe("fan_only");
  });
});
