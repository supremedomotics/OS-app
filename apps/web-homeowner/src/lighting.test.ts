import { describe, expect, it } from "vitest";
import { resolveColorMode } from "./lighting.js";

/**
 * § PASS 23 — regression coverage for the "CCT slider disappears when moved" live defect.
 * Root cause: `ui.showRGB`/`ui.showCCT` are state-derived (not static) for a device with no
 * structural `colorModes` config yet, so a sticky tab override could point at a mode that
 * later became unavailable, hiding BOTH the ColorWheel and the TempSlider at once.
 */
describe("resolveColorMode", () => {
  it("no override yet — CCT-only device defaults to white", () => {
    expect(resolveColorMode(null, false, true)).toBe("white");
  });

  it("no override yet — RGB-only device defaults to colour", () => {
    expect(resolveColorMode(null, true, false)).toBe("colour");
  });

  it("no override yet — RGB+CCT device defaults to colour", () => {
    expect(resolveColorMode(null, true, true)).toBe("colour");
  });

  it("override still valid — respected", () => {
    expect(resolveColorMode("white", true, true)).toBe("white");
    expect(resolveColorMode("colour", true, true)).toBe("colour");
  });

  it("§ PASS 23 bug fix — a stale 'colour' override on a device that just lost RGB (feedback flipped it to CCT-only) falls back to white, not a vanished control", () => {
    // User clicked "Colour" while showRGB was still (state-inferred) true; a kelvin-only
    // feedback telegram then arrived and flipped showRGB to false. Before the fix, `mode`
    // stayed "colour" while `showRGB` was false — neither control rendered.
    expect(resolveColorMode("colour", false, true)).toBe("white");
  });

  it("§ PASS 23 bug fix — a stale 'white' override on a device that lost CCT falls back to colour", () => {
    expect(resolveColorMode("white", true, false)).toBe("colour");
  });

  it("neither mode available (no color capability) — degrades to colour, never throws", () => {
    expect(resolveColorMode(null, false, false)).toBe("colour");
    expect(resolveColorMode("white", false, false)).toBe("colour");
  });
});
