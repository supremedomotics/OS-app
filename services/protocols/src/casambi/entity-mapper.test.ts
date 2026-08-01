import { describe, expect, it } from "vitest";
import {
  capabilitiesFromUnit,
  colorConfigFromUnit,
  commandToTargetControls,
  rgbToHueSat,
  statesFromUnit,
  type CasambiUnit,
} from "./entity-mapper.js";

describe("Casambi codec — capability derivation", () => {
  it("derives brightness for a dimmable luminaire", () => {
    const u: CasambiUnit = { id: 1, type: "Luminaire", controls: [{ type: "Dimmer", value: 0.5 }] };
    expect(capabilitiesFromUnit(u)).toEqual(["brightness"]);
  });

  it("derives brightness + color for a tunable/RGB luminaire", () => {
    const u: CasambiUnit = {
      id: 2,
      type: "Luminaire",
      controls: [{ type: "Dimmer", value: 1 }, { type: "CCT", value: 4000, min: 2700, max: 6000 }],
    };
    expect(capabilitiesFromUnit(u)).toEqual(["brightness", "color"]);
  });

  it("derives onoff for a non-dimmable relay", () => {
    const u: CasambiUnit = { id: 3, type: "Luminaire", controls: [{ type: "OnOff", value: 1 }] };
    expect(capabilitiesFromUnit(u)).toEqual(["onoff"]);
  });

  it("derives position for a shade/slider unit", () => {
    const u: CasambiUnit = { id: 4, controls: [{ type: "Slider", value: 40, min: 0, max: 100 }] };
    expect(capabilitiesFromUnit(u)).toEqual(["position"]);
  });

  it("derives a sensor for sensor units", () => {
    const u: CasambiUnit = { id: 5, type: "Sensor", sensors: { lux: 320 } };
    expect(capabilitiesFromUnit(u)).toEqual(["sensor"]);
  });
});

describe("Casambi codec — colorConfigFromUnit (§ ADR 0017 Capability Normalization)", () => {
  it("a unit with no color-related control at all → undefined (nothing to normalize)", () => {
    const u: CasambiUnit = { id: 10, controls: [{ type: "Dimmer", value: 1 }] };
    expect(colorConfigFromUnit(u)).toBeUndefined();
  });

  it("CCT-only fixture (real hardware shape: CCT control, no RGB/XY) → colorModes.cct only", () => {
    const u: CasambiUnit = { id: 11, controls: [{ type: "Dimmer" }, { type: "CCT", min: 2700, max: 6000 }] };
    expect(colorConfigFromUnit(u)).toEqual({ colorModes: { rgb: false, cct: true } });
  });

  it("RGB-only fixture (RGB control, no CCT) → colorModes.rgb only", () => {
    const u: CasambiUnit = { id: 12, controls: [{ type: "Dimmer" }, { type: "RGB" }] };
    expect(colorConfigFromUnit(u)).toEqual({ colorModes: { rgb: true, cct: false } });
  });

  it("XY control counts as RGB (Casambi's alternate color-mode encoding)", () => {
    const u: CasambiUnit = { id: 13, controls: [{ type: "Dimmer" }, { type: "xy" }] };
    expect(colorConfigFromUnit(u)).toEqual({ colorModes: { rgb: true, cct: false } });
  });

  it("RGB+CCT fixture → both true — known structurally, not guessed from state", () => {
    const u: CasambiUnit = { id: 14, controls: [{ type: "Dimmer" }, { type: "RGB" }, { type: "CCT" }] };
    expect(colorConfigFromUnit(u)).toEqual({ colorModes: { rgb: true, cct: true } });
  });

  it("Colortemperature control name variant also maps to cct", () => {
    const u: CasambiUnit = { id: 15, controls: [{ type: "Colortemperature", min: 2200, max: 6500 }] };
    expect(colorConfigFromUnit(u)).toEqual({ colorModes: { rgb: false, cct: true } });
  });
});

describe("Casambi codec — state normalization", () => {
  it("normalizes dim level to on + percent", () => {
    const u: CasambiUnit = { id: 1, type: "Luminaire", dimLevel: 0.5, controls: [{ type: "Dimmer", value: 0.5 }] };
    expect(statesFromUnit(u)).toEqual([{ capability: "brightness", state: { kind: "brightness", on: true, level: 50 } }]);
  });

  it("reads an explicit off flag over a stale dim level", () => {
    const u: CasambiUnit = { id: 1, type: "Luminaire", on: false, dimLevel: 0.5, controls: [{ type: "Dimmer", value: 0.5 }] };
    const [b] = statesFromUnit(u);
    expect(b.state).toEqual({ kind: "brightness", on: false, level: 50 });
  });

  it("extracts hue/sat and kelvin from colour controls", () => {
    const u: CasambiUnit = {
      id: 2,
      type: "Luminaire",
      dimLevel: 1,
      controls: [
        { type: "Dimmer", value: 1 },
        { type: "Color", rgb: "rgb(255, 0, 0)" },
        { type: "CCT", value: 4000, min: 2700, max: 6000 },
      ],
    };
    const color = statesFromUnit(u).find((s) => s.capability === "color");
    expect(color?.state).toMatchObject({ kind: "color", on: true, level: 100, hue: 0, saturation: 100, kelvin: 4000 });
  });

  it("normalizes a slider to a 0..100 position", () => {
    const u: CasambiUnit = { id: 4, controls: [{ type: "Slider", value: 30, min: 0, max: 100 }] };
    expect(statesFromUnit(u)).toEqual([{ capability: "position", state: { kind: "position", position: 30, moving: false } }]);
  });

  it("surfaces the primary sensor reading", () => {
    const u: CasambiUnit = { id: 5, type: "Sensor", sensors: { lux: 320 } };
    expect(statesFromUnit(u)).toEqual([{ capability: "sensor", state: { kind: "sensor", value: 320, unit: "lx", measure: "lux" } }]);
  });
});

describe("Casambi codec — rgbToHueSat", () => {
  it("maps primaries", () => {
    expect(rgbToHueSat(255, 0, 0)).toEqual({ hue: 0, saturation: 100 });
    expect(rgbToHueSat(0, 255, 0)).toEqual({ hue: 120, saturation: 100 });
    expect(rgbToHueSat(0, 0, 255)).toEqual({ hue: 240, saturation: 100 });
    expect(rgbToHueSat(255, 255, 255)).toEqual({ hue: 0, saturation: 0 });
  });
});

describe("Casambi codec — command translation", () => {
  it("maps onoff to the OnOff control", () => {
    expect(commandToTargetControls({ capability: "onoff", action: "on" }, null)).toEqual({ OnOff: { value: 1 } });
    expect(commandToTargetControls({ capability: "onoff", action: "off" }, null)).toEqual({ OnOff: { value: 0 } });
    expect(
      commandToTargetControls({ capability: "onoff", action: "toggle" }, { kind: "onoff", on: true }),
    ).toEqual({ OnOff: { value: 0 } });
  });

  it("maps brightness to a 0..1 Dimmer", () => {
    expect(commandToTargetControls({ capability: "brightness", action: "set", level: 40 }, null)).toEqual({ Dimmer: { value: 0.4 } });
    expect(commandToTargetControls({ capability: "brightness", action: "off" }, null)).toEqual({ Dimmer: { value: 0 } });
    expect(commandToTargetControls({ capability: "brightness", action: "on" }, null)).toEqual({ Dimmer: { value: 1 } });
  });

  it("maps colour temperature with the TW colour source", () => {
    expect(commandToTargetControls({ capability: "color", kelvin: 3000 }, null)).toEqual({
      ColorTemperature: { value: 3000 },
      Colorsource: { source: "TW" },
    });
  });

  it("maps hue/saturation with the RGB colour source, filling from prior state", () => {
    expect(
      commandToTargetControls({ capability: "color", hue: 180 }, { kind: "color", on: true, level: 100, hue: 0, saturation: 50, kelvin: null }),
    ).toEqual({ RGB: { hue: 0.5, sat: 0.5 }, Colorsource: { source: "RGB" } });
  });

  it("maps position open/close/set to the Slider, and returns null for stop", () => {
    expect(commandToTargetControls({ capability: "position", action: "open" }, null)).toEqual({ Slider: { value: 100 } });
    expect(commandToTargetControls({ capability: "position", action: "close" }, null)).toEqual({ Slider: { value: 0 } });
    expect(commandToTargetControls({ capability: "position", action: "set", position: 60 }, null)).toEqual({ Slider: { value: 60 } });
    expect(commandToTargetControls({ capability: "position", action: "stop" }, null)).toBeNull();
  });
});
