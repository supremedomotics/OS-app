import { describe, expect, it } from "vitest";
import { ventilationDecision, VentilationError, VentilationRunner, validateVentilationConfig } from "./ventilation-runner.js";

const cfg = { highThreshold: 1000, lowThreshold: 700 };

describe("ventilationDecision (hysteresis)", () => {
  it("turns on above high, off below low, holds in between", () => {
    expect(ventilationDecision(1100, cfg, false)).toBe(true); // stale + off → on
    expect(ventilationDecision(1100, cfg, true)).toBeNull(); // stale + already on → hold
    expect(ventilationDecision(650, cfg, true)).toBe(false); // clear + on → off
    expect(ventilationDecision(650, cfg, false)).toBeNull(); // clear + off → hold
    expect(ventilationDecision(850, cfg, true)).toBeNull(); // in band, on → hold
    expect(ventilationDecision(850, cfg, false)).toBeNull(); // in band, off → hold
  });
});

describe("validateVentilationConfig", () => {
  it("accepts valid config and rejects bad hysteresis", () => {
    expect(validateVentilationConfig({ sensorDeviceId: "s", fanDeviceId: "f", highThreshold: 1000, lowThreshold: 700 }).fanDeviceId).toBe("f");
    expect(() => validateVentilationConfig({ sensorDeviceId: "s", fanDeviceId: "f", highThreshold: 700, lowThreshold: 1000 })).toThrow(/hysteresis/);
    expect(() => validateVentilationConfig({ fanDeviceId: "f", highThreshold: 1000, lowThreshold: 700 })).toThrow(VentilationError);
  });
});

describe("VentilationRunner", () => {
  it("runs the fan when air is stale and stops it when it clears, without flapping", async () => {
    const fanOps: boolean[] = [];
    let reading = 500;
    const runner = new VentilationRunner({
      getConfig: async () => ({ sensorDeviceId: "co2", fanDeviceId: "fan", highThreshold: 1000, lowThreshold: 700 }),
      readSensor: async () => reading,
      setFan: async (_id, on) => void fanOps.push(on),
    });

    await runner.tick(); // 500, off → hold
    expect(fanOps).toEqual([]);
    reading = 1200;
    await runner.tick(); // stale → on
    expect(fanOps).toEqual([true]);
    reading = 1100;
    await runner.tick(); // still above low → hold (no flap)
    expect(fanOps).toEqual([true]);
    reading = 800;
    await runner.tick(); // in band → hold
    expect(fanOps).toEqual([true]);
    reading = 650;
    await runner.tick(); // below low → off
    expect(fanOps).toEqual([true, false]);
    expect(runner.currentFanState).toBe(false);
  });

  it("does nothing without config or a sensor reading", async () => {
    const fanOps: boolean[] = [];
    const noCfg = new VentilationRunner({ getConfig: async () => undefined, readSensor: async () => 1200, setFan: async (_i, on) => void fanOps.push(on) });
    await noCfg.tick();
    const noReading = new VentilationRunner({ getConfig: async () => ({ sensorDeviceId: "s", fanDeviceId: "f", highThreshold: 1000, lowThreshold: 700 }), readSensor: async () => undefined, setFan: async (_i, on) => void fanOps.push(on) });
    await noReading.tick();
    expect(fanOps).toEqual([]);
  });
});
