import { describe, expect, it } from "vitest";
import { Thermostat } from "@matter/main/clusters/thermostat";
import {
  celsiusToMatter,
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
