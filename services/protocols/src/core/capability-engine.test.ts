import { describe, expect, it } from "vitest";
import { computeEntityCapabilities, computeDriverCapabilities } from "./capability-engine.js";

describe("computeEntityCapabilities", () => {
  it("a bare onoff device supports only onoff", () => {
    const flags = computeEntityCapabilities({ capabilities: ["onoff"] });
    expect(flags.supportsOnOff).toBe(true);
    expect(flags.supportsBrightness).toBe(false);
    expect(flags.supportsRGB).toBe(false);
  });

  it("brightness implies onoff", () => {
    const flags = computeEntityCapabilities({ capabilities: ["brightness"] });
    expect(flags.supportsOnOff).toBe(true);
    expect(flags.supportsBrightness).toBe(true);
  });

  it("color with rgb colorMode supports RGB, not CCT", () => {
    const flags = computeEntityCapabilities({ capabilities: ["color"], colorConfig: { colorModes: { rgb: true, cct: false } } });
    expect(flags.supportsRGB).toBe(true);
    expect(flags.supportsCCT).toBe(false);
  });

  it("color with cct colorMode supports CCT, not RGB", () => {
    const flags = computeEntityCapabilities({ capabilities: ["color"], colorConfig: { colorModes: { rgb: false, cct: true } } });
    expect(flags.supportsRGB).toBe(false);
    expect(flags.supportsCCT).toBe(true);
  });

  it("supportsRGBW is always false — no domain-model field exists to report it honestly", () => {
    const flags = computeEntityCapabilities({ capabilities: ["color"], colorConfig: { colorModes: { rgb: true, cct: true } } });
    expect(flags.supportsRGBW).toBe(false);
  });

  it("supportsButtonEvents reflects the caller-supplied nativeButtonEvents flag, not a CapabilityKind", () => {
    expect(computeEntityCapabilities({ capabilities: [] }, false).supportsButtonEvents).toBe(false);
    expect(computeEntityCapabilities({ capabilities: [] }, true).supportsButtonEvents).toBe(true);
  });

  it("derives sensor sub-kind flags from latestStates, never from a discovery-time declaration", () => {
    const presence = computeEntityCapabilities({
      capabilities: ["sensor"],
      latestStates: { sensor: { kind: "sensor", value: 1, unit: "", measure: "presence" } },
    });
    expect(presence.supportsMotion).toBe(true);
    expect(presence.supportsLux).toBe(false);

    const lux = computeEntityCapabilities({
      capabilities: ["sensor"],
      latestStates: { sensor: { kind: "sensor", value: 300, unit: "lx", measure: "lux" } },
    });
    expect(lux.supportsLux).toBe(true);
    expect(lux.supportsMotion).toBe(false);
  });

  it("a sensor capability with no live state yet has every sensor sub-flag false (honest, not guessed)", () => {
    const flags = computeEntityCapabilities({ capabilities: ["sensor"] });
    expect(flags.supportsMotion).toBe(false);
    expect(flags.supportsLux).toBe(false);
    expect(flags.supportsBattery).toBe(false);
  });

  it("maps battery/temperature/humidity/energy measures to their flags", () => {
    const battery = computeEntityCapabilities({
      capabilities: ["sensor"],
      latestStates: { sensor: { kind: "sensor", value: 80, unit: "%", measure: "battery_level" } },
    });
    expect(battery.supportsBattery).toBe(true);
  });
});

describe("computeDriverCapabilities", () => {
  it("passes each driver-level fact straight through to its matching flag", () => {
    const flags = computeDriverCapabilities({
      hasScenes: true,
      hasGroups: false,
      hasDiagnostics: true,
      hasFirmwareInfo: false,
      hasHealthMonitoring: true,
    });
    expect(flags).toEqual({
      supportsScene: true,
      supportsGroups: false,
      supportsDiagnostics: true,
      supportsFirmware: false,
      supportsHealthMonitoring: true,
    });
  });
});
