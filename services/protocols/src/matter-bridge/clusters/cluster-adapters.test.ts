import { describe, it, expect } from "vitest";
import { onOffToMatter, onOffFromMatter } from "./onoff-adapter.js";
import { levelToMatter, levelFromMatter } from "./level-control-adapter.js";
import { hueToMatter, hueFromMatter, saturationToMatter, saturationFromMatter, kelvinToMireds, miredsToKelvin } from "./color-control-adapter.js";
import { positionToMatterPercent100ths, positionFromMatterPercent100ths } from "./window-covering-adapter.js";

describe("OnOffAdapter", () => {
  it("round-trips both states", () => {
    expect(onOffToMatter(true)).toBe(true);
    expect(onOffToMatter(false)).toBe(false);
    expect(onOffFromMatter(true)).toBe("on");
    expect(onOffFromMatter(false)).toBe("off");
  });
});

describe("LevelControlAdapter — SupremeOS 0-100% <-> Matter CurrentLevel 1-254", () => {
  it("0% still maps to the Matter minimum of 1, never 0 (Lighting device types forbid CurrentLevel=0)", () => {
    expect(levelToMatter(0)).toBe(1);
  });
  it("100% maps to 254", () => {
    expect(levelToMatter(100)).toBe(254);
  });
  it("round-trips a mid-range value within rounding tolerance", () => {
    const back = levelFromMatter(levelToMatter(50));
    expect(Math.abs(back - 50)).toBeLessThanOrEqual(1);
  });
});

describe("ColorControlAdapter — hue/saturation/kelvin conversions", () => {
  it("hue round-trips 0/120/360 within rounding tolerance", () => {
    for (const deg of [0, 120, 359]) {
      expect(Math.abs(hueFromMatter(hueToMatter(deg)) - deg)).toBeLessThanOrEqual(2);
    }
  });
  it("saturation round-trips 0/50/100 within rounding tolerance", () => {
    for (const pct of [0, 50, 100]) {
      expect(Math.abs(saturationFromMatter(saturationToMatter(pct)) - pct)).toBeLessThanOrEqual(1);
    }
  });
  it("kelvin <-> mireds is the standard reciprocal-megakelvin conversion", () => {
    expect(kelvinToMireds(2000)).toBe(500);
    expect(miredsToKelvin(500)).toBe(2000);
    expect(kelvinToMireds(6500)).toBe(154); // 1_000_000/6500 = 153.8 -> 154
  });
});

describe("WindowCoveringAdapter — SPEC-INVERTED position scale", () => {
  it("SupremeOS fully open (100) -> Matter fully open (0 percent100ths)", () => {
    expect(positionToMatterPercent100ths(100)).toBe(0);
  });
  it("SupremeOS fully closed (0) -> Matter fully closed (10000 percent100ths)", () => {
    expect(positionToMatterPercent100ths(0)).toBe(10000);
  });
  it("SupremeOS 75% open -> Matter 25% (2500 percent100ths)", () => {
    expect(positionToMatterPercent100ths(75)).toBe(2500);
  });
  it("round-trips through both conversions", () => {
    for (const pos of [0, 25, 50, 75, 100]) {
      expect(positionFromMatterPercent100ths(positionToMatterPercent100ths(pos))).toBe(pos);
    }
  });
  it("Matter fully open (0) -> SupremeOS fully open (100)", () => {
    expect(positionFromMatterPercent100ths(0)).toBe(100);
  });
  it("Matter fully closed (10000) -> SupremeOS fully closed (0)", () => {
    expect(positionFromMatterPercent100ths(10000)).toBe(0);
  });
});
