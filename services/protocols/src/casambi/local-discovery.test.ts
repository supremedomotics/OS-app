import { describe, expect, it } from "vitest";
import { updateUnitFromControlValues } from "./local-discovery.js";
import { capabilitiesFromUnit, statesFromUnit } from "./entity-mapper.js";
import type { CasambiControlValue } from "./local-transport/udp-codec.js";

const cv = (type: number, ...valueBytes: number[]): CasambiControlValue => ({
  type,
  typeName: "test",
  valueBytes,
});

describe("updateUnitFromControlValues — slider / curtain position (§ live-confirmed)", () => {
  // Real bytes from a Casambi curtain motor's gateway trace: `4b.2d.0f.88.00` — type 15 (slider,
  // short form, 2-byte little-endian) reading 0x0088 = 136 while the Casambi app showed 53.3%.
  it("decodes a type-15 slider as a position capability at the live-confirmed 0-255 scale", () => {
    const unit = updateUnitFromControlValues(45, [cv(15, 0x88, 0x00)]);
    expect(capabilitiesFromUnit(unit)).toEqual(["position"]);
    const state = statesFromUnit(unit).find((s) => s.capability === "position")!.state;
    expect(state).toEqual({ kind: "position", position: 53, moving: false }); // 136/255 = 53.3%
  });

  it("reads the full travel range, so a fully-open motor is not clamped at 39%", () => {
    // Without an explicit max the shared mapper assumes 100, which would report 0xFF as "100%"
    // only by accident and 0x88 as "100%" wrongly — this pins the real 0-255 range.
    const open = updateUnitFromControlValues(45, [cv(15, 0xff, 0x00)]);
    expect(statesFromUnit(open).find((s) => s.capability === "position")!.state).toMatchObject({ position: 100 });
    const shut = updateUnitFromControlValues(45, [cv(15, 0x00, 0x00)]);
    expect(statesFromUnit(shut).find((s) => s.capability === "position")!.state).toMatchObject({ position: 0 });
  });

  it("a later slider report replaces the previous one rather than accumulating controls", () => {
    const first = updateUnitFromControlValues(45, [cv(15, 0x01, 0x00)]);
    const second = updateUnitFromControlValues(45, [cv(15, 0x88, 0x00)], first);
    expect((second.controls ?? []).filter((c) => c.type === "slider")).toHaveLength(1);
    expect(statesFromUnit(second).find((s) => s.capability === "position")!.state).toMatchObject({ position: 53 });
  });
});

describe("updateUnitFromControlValues", () => {
  it("maps a dimmer channel (type 1) into the shared entity-mapper's dimLevel/controls shape", () => {
    const unit = updateUnitFromControlValues(5, [cv(1, 128)]);
    expect(unit.id).toBe(5);
    expect(unit.dimLevel).toBeCloseTo(128 / 255);
    expect(unit.controls).toEqual([{ type: "dimmer", value: 128 / 255 }]);
    // Reuses the SAME capability inference Cloud units go through — additive, not forked.
    expect(capabilitiesFromUnit(unit)).toEqual(["brightness"]);
  });

  it("maps on/off toggle (type 16) onto the unit's `on` flag", () => {
    const unit = updateUnitFromControlValues(5, [cv(16, 1)]);
    expect(unit.on).toBe(true);
    expect(capabilitiesFromUnit(unit)).toEqual(["onoff"]);
  });

  it("maps presence (21), lux (20), battery (7), and device temperature (6) into `sensors`", () => {
    const unit = updateUnitFromControlValues(9, [cv(21, 1), cv(20, 0x2c, 0x01), cv(7, 80), cv(6, 22)]);
    expect(unit.sensors).toEqual({ presence: 1, lux: 300, battery_level: 80, temperature: 22 });
    expect(capabilitiesFromUnit(unit)).toEqual(["sensor"]);
  });

  it("battery/temperature value 0 means 'undefined' per the doc and is not recorded", () => {
    const unit = updateUnitFromControlValues(9, [cv(7, 0), cv(6, 0)]);
    expect(unit.sensors).toBeUndefined();
  });

  it("ignores unsupported/color-related types (2/3/4/5/11) rather than fabricating a mapping", () => {
    const unit = updateUnitFromControlValues(5, [cv(2, 200), cv(3, 1, 2, 3), cv(11, 5)]);
    expect(unit.controls).toBeUndefined();
    expect(unit.sensors).toBeUndefined();
    expect(capabilitiesFromUnit(unit)).toEqual(["onoff"]); // default when nothing else matched
  });

  it("merges progressively across multiple NotifyControlValues packets for the same unit", () => {
    const first = updateUnitFromControlValues(5, [cv(1, 255)]);
    const second = updateUnitFromControlValues(5, [cv(16, 1)], first);
    expect(second.dimLevel).toBe(1);
    expect(second.on).toBe(true);
    expect(second.controls).toEqual([{ type: "dimmer", value: 1 }]);
  });

  it("long-form entries (0x80 bit set) are read the same way as short-form for supported types", () => {
    // 0x81 is dimmerChannel's documented long-form dual of short-form type 1 (p.277).
    const unit = updateUnitFromControlValues(5, [{ type: 0x81, typeName: "dimmerChannel", index: 0, valueBytes: [255] }]);
    expect(unit.dimLevel).toBe(1);
  });

  it("maps color temperature (type 10) into a `colortemperature` control, surfacing the fixture as tunable white", () => {
    const unit = updateUnitFromControlValues(5, [cv(1, 128), cv(10, 0x80)]);
    expect(unit.controls).toEqual([{ type: "dimmer", value: 128 / 255 }, { type: "colortemperature", value: 0x80 }]);
    expect(capabilitiesFromUnit(unit)).toEqual(["brightness", "color"]);
    // The reported byte is normalized-to-fixture-range (§ manual p.223), not literal Kelvin —
    // never fabricate a Kelvin reading from it.
    expect(statesFromUnit(unit).find((s) => s.capability === "color")?.state).toMatchObject({ kelvin: null });
  });

  it("a dimmable+sensor mix produces the same states via statesFromUnit as a Cloud unit would", () => {
    const unit = updateUnitFromControlValues(5, [cv(1, 128)]);
    const states = statesFromUnit(unit);
    expect(states).toEqual([{ capability: "brightness", state: { kind: "brightness", on: true, level: 50 } }]);
  });
});
