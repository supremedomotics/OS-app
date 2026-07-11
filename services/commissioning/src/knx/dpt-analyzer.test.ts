import { describe, expect, it } from "vitest";
import { classifyDpt, isReadonlyCategory } from "./dpt-analyzer.js";

describe("DPT analyzer", () => {
  it("classifies well-known subtypes exactly", () => {
    expect(classifyDpt("1.001").category).toBe("binary_switch");
    expect(classifyDpt("1.018").category).toBe("binary_occupancy");
    expect(classifyDpt("1.019").category).toBe("binary_windowdoor");
    expect(classifyDpt("3.007").category).toBe("step_dimming");
    expect(classifyDpt("3.008").category).toBe("step_blind");
    expect(classifyDpt("5.001").category).toBe("percentage");
    expect(classifyDpt("7.600").category).toBe("color_temperature_kelvin");
    expect(classifyDpt("9.001").category).toBe("float_temperature");
    expect(classifyDpt("9.007").category).toBe("float_humidity");
    expect(classifyDpt("9.008").category).toBe("float_co2");
    expect(classifyDpt("13.010").category).toBe("counter_energy");
    expect(classifyDpt("14.056").category).toBe("float14_power");
    expect(classifyDpt("14.027").category).toBe("float14_voltage");
    expect(classifyDpt("14.019").category).toBe("float14_current");
    expect(classifyDpt("18.001").category).toBe("scene_control");
    expect(classifyDpt("20.102").category).toBe("hvac_mode");
    expect(classifyDpt("20.105").category).toBe("hvac_fan_speed");
    expect(classifyDpt("232.600").category).toBe("color_rgb");
    expect(classifyDpt("251.600").category).toBe("color_rgbw");
  });

  it("falls back to the major-type shape for unlisted subtypes", () => {
    const c = classifyDpt("9.099");
    expect(c.category).toBe("float_generic");
    expect(c.isFallback).toBe(true);
  });

  it("never throws on missing/malformed DPTs", () => {
    expect(classifyDpt(null).category).toBe("unknown");
    expect(classifyDpt(undefined).category).toBe("unknown");
    expect(classifyDpt("").category).toBe("unknown");
    expect(classifyDpt("not-a-dpt").category).toBe("unknown");
  });

  it("marks telemetry categories read-only", () => {
    expect(isReadonlyCategory("float_temperature")).toBe(true);
    expect(isReadonlyCategory("counter_energy")).toBe(true);
    expect(isReadonlyCategory("binary_switch")).toBe(false);
    expect(isReadonlyCategory("percentage")).toBe(false);
  });
});
