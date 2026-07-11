import { describe, expect, it } from "vitest";
import {
  indoorUnitCapabilityConfig,
  indoorUnitCommandLines,
  indoorUnitDiscoveredDevice,
  mainControllerOnOffState,
  unitOnOffState,
  unitTemperatureState,
  ventilationFanState,
  waterHeaterOnOffState,
  waterHeaterTemperatureState,
} from "./coolmaster-mapper.js";
import { parseLs2Line } from "./coolmaster-parser.js";
import type {
  CoolMasterGatewayInfo,
  CoolMasterMainControllerStatus,
  CoolMasterVentilationStatus,
  CoolMasterWaterHeaterStatus,
} from "./coolmaster-types.js";

const gateway: CoolMasterGatewayInfo = { serial: "ABC123", firmwareVersion: "1.0", application: "CoolMasterNet", host: "192.168.1.50" };

describe("indoor unit -> Supreme state", () => {
  const unit = parseLs2Line("L1.100 ON 24.0C 22.5C Low Cool OK - 0")!;

  it("maps onoff", () => {
    expect(unitOnOffState(unit)).toEqual({ kind: "onoff", on: true });
  });

  it("maps temperature with fan speed carried in the advanced bag", () => {
    const state = unitTemperatureState(unit);
    expect(state).toMatchObject({ kind: "temperature", ambientC: 22.5, targetC: 24, mode: "cool" });
    expect((state as { advanced: Record<string, unknown> }).advanced).toMatchObject({ fanSpeed: "Low" });
  });

  it("has no advanced bag at all when nothing extra was reported", () => {
    const bare = { uid: "L1.101", line: "L1", on: false, setpointC: 20, roomC: 19, mode: null, fanSpeed: null, swing: null, filterWarning: null, demand: null, faultCode: null, locked: null, inhibited: null, exitCode: "OK", source: "ascii" as const };
    const state = unitTemperatureState(bare) as { advanced: unknown };
    expect(state.advanced).toBeNull();
  });

  it("off unit reports Supreme mode off regardless of its last HVAC mode", () => {
    const off = parseLs2Line("L1.102 OFF 20.0C 19.0C Auto Heat OK - 0")!;
    expect(unitTemperatureState(off)).toMatchObject({ mode: "off" });
  });
});

describe("water heater -> Supreme state (reuses temperature, heat-only)", () => {
  const wh: CoolMasterWaterHeaterStatus = { uid: "W1.001", on: true, setpointC: 55, roomC: 48, faultCode: null };
  it("maps onoff", () => {
    expect(waterHeaterOnOffState(wh)).toEqual({ kind: "onoff", on: true });
  });
  it("maps temperature to heat mode when on", () => {
    expect(waterHeaterTemperatureState(wh)).toMatchObject({ kind: "temperature", targetC: 55, ambientC: 48, mode: "heat" });
  });
  it("maps to off mode when off", () => {
    expect(waterHeaterTemperatureState({ ...wh, on: false }).mode).toBe("off");
  });
});

describe("ventilation -> Supreme fan state (documented approximation)", () => {
  it("maps High to the turbo preset", () => {
    const vam: CoolMasterVentilationStatus = { uid: "V1.001", on: true, fanSpeed: "High", faultCode: null };
    expect(ventilationFanState(vam)).toEqual({ kind: "fan", on: true, preset: "turbo", direction: "forward" });
  });
  it("maps Low to the sleep preset and unknown/Auto to auto", () => {
    expect(ventilationFanState({ uid: "V1", on: true, fanSpeed: "Low", faultCode: null }).preset).toBe("sleep");
    expect(ventilationFanState({ uid: "V1", on: true, fanSpeed: null, faultCode: null }).preset).toBe("auto");
  });
});

describe("main controller -> Supreme state", () => {
  it("maps onoff only", () => {
    const main: CoolMasterMainControllerStatus = { uid: "M1.001", on: false, faultCode: null };
    expect(mainControllerOnOffState(main)).toEqual({ kind: "onoff", on: false });
  });
});

describe("DiscoveredDevice construction", () => {
  it("builds an indoor unit device with the right capabilities and metadata", () => {
    const unit = parseLs2Line("L1.100 ON 24.0C 22.5C Low Cool OK - 0")!;
    const device = indoorUnitDiscoveredDevice(unit, gateway);
    expect(device.capabilities).toEqual(["onoff", "temperature"]);
    expect(device.backendId).toBe("L1.100");
    expect(device.raw.coolmaster).toMatchObject({ uid: "L1.100", line: "L1", gatewaySerial: "ABC123", deviceKind: "indoor_unit" });
  });
});

describe("ClimateCapabilityConfig", () => {
  it("only offers lock/inhibit controls when the unit actually reports them", () => {
    const withLock = parseLs2Line("L1.100 ON 24.0C 22.5C Low Cool OK - 0")!;
    withLock.locked = true;
    const config = indoorUnitCapabilityConfig(withLock, ["Auto", "Low", "High"], []);
    expect(config.advancedControls?.some((c) => c.key === "locked")).toBe(true);
    expect(config.advancedControls?.some((c) => c.key === "inhibited")).toBe(false); // unit.inhibited is null
    expect(config.fanSpeeds).toEqual(["Auto", "Low", "High"]);
  });
});

describe("Supreme command -> ASCII_IF command lines", () => {
  it("maps a plain on/off command", () => {
    expect(indoorUnitCommandLines("L1.100", { capability: "onoff", action: "on" })).toEqual(["on L1.100"]);
  });

  it("maps a temperature command with mode + setpoint into two lines", () => {
    expect(indoorUnitCommandLines("L1.100", { capability: "temperature", mode: "heat", targetC: 22 })).toEqual(["heat L1.100", "temp L1.100 22"]);
  });

  it("maps mode 'off' to the off command, and fan_only to the fan mode word", () => {
    expect(indoorUnitCommandLines("L1.100", { capability: "temperature", mode: "off" })).toEqual(["off L1.100"]);
    expect(indoorUnitCommandLines("L1.100", { capability: "temperature", mode: "fan_only" })).toEqual(["fan L1.100"]);
  });

  it("maps advanced fan speed / swing / lock / inhibit / filter reset", () => {
    const lines = indoorUnitCommandLines("L1.100", {
      capability: "temperature",
      advanced: { fanSpeed: "High", swing: "Auto", locked: true, inhibited: false, filterReset: true },
    });
    expect(lines).toEqual(["fspeed L1.100 High", "swing L1.100 Auto", "lock L1.100 on", "inhibit L1.100 off", "filt L1.100 reset"]);
  });

  it("returns null for toggle (caller must resolve it from cached state first)", () => {
    expect(indoorUnitCommandLines("L1.100", { capability: "onoff", action: "toggle" })).toBeNull();
  });

  it("returns null for an unrelated capability", () => {
    expect(indoorUnitCommandLines("L1.100", { capability: "lock", action: "lock" })).toBeNull();
  });
});
