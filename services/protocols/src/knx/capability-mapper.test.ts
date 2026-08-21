import { describe, expect, it } from "vitest";
import { classifyEtsSignal, classifyFromText, classifyFunctionalBlock, colorModesFromDpt, mergeCapabilityHints, resolveDpt5001Semantic } from "./capability-mapper.js";
import { parseFunctionalBlocks } from "./functional-block-parser.js";

describe("classifyFromText", () => {
  it("classifies an RGBW light from a circuit name", () => {
    const hint = classifyFromText("Kitchen Light RGBW");
    expect(hint.deviceKind).toBe("rgbw_light");
    expect(hint.capabilities).toEqual(expect.arrayContaining(["onoff", "brightness", "color"]));
  });

  it("classifies a blind from a functional block title", () => {
    expect(classifyFromText("Living Room Blind Position").deviceKind).toBe("blind");
  });

  it("returns unknown, never a guessed capability, for unrecognized text", () => {
    const hint = classifyFromText("Xyzzy Foo Bar");
    expect(hint).toEqual({ capabilities: [], deviceKind: "unknown", matchedOn: [] });
  });

  it("§ Correctness Fix — classifies a fan by name for diagnostics, but never advertises the unsupported fan capability", () => {
    // knx-codec.ts has no case for the `fan` capability at all — commanding one would
    // always throw, so this must never appear in `capabilities` (§ Never advertise
    // unsupported functionality). `deviceKind` still reports "fan" — that's
    // driver-internal labeling, never part of the outward capability contract.
    const hint = classifyFromText("Bathroom Ventilation Fan");
    expect(hint.deviceKind).toBe("fan");
    expect(hint.capabilities).toEqual([]);
  });

  it("§ Correctness Fix — same for the DPT-based fan_speed_percentage/hvac_fan_speed signals", () => {
    // DPT 5.100 (Fan Speed %) and DPT 20.105 (HVAC Fan Speed) both classify their
    // device kind correctly for diagnostics, but neither advertises `fan` since
    // knx-codec.ts still can't execute it.
    expect(classifyEtsSignal("5.100", "AHU Fan Speed")).toMatchObject({ deviceKind: "fan", capabilities: [] });
    expect(classifyEtsSignal("20.105", "AHU Fan Speed Mode")).toMatchObject({ deviceKind: "fan", capabilities: [] });
  });
});

describe("classifyFunctionalBlock + mergeCapabilityHints", () => {
  it("merges on/off and status blocks for the same device into one capability set", () => {
    const body = '</fb/1/sw>;rt="urn:knx:fb.onoff";if="if.a";title="Kitchen Light",</fb/1/dim>;rt="urn:knx:fb.dim";if="if.a";title="Kitchen Light Dim"';
    const { blocks } = parseFunctionalBlocks(body);
    const hints = blocks.map(classifyFunctionalBlock);
    const merged = mergeCapabilityHints(hints);
    expect(merged.capabilities).toEqual(expect.arrayContaining(["onoff", "brightness"]));
    expect(merged.deviceKind).toBe("light");
  });

  it("never fabricates a device kind when no hint matched anything", () => {
    expect(mergeCapabilityHints([]).deviceKind).toBe("unknown");
  });
});

describe("resolveDpt5001Semantic — DPT 5.001 disambiguation (Pass 6, diagnostic-only, never wired into classifyEtsSignal)", () => {
  it("1: resolves brightness from strong communication-object function text", () => {
    const result = resolveDpt5001Semantic({ dpt: "5.001", comObjectText: "Absolute Brightness Value", gaName: "Living Room Light Brightness" });
    expect(result.semantic).toBe("brightness");
    expect(result.confidence).toBe("high");
  });

  it("2: resolves position from strong communication-object function text (blind actuator)", () => {
    const result = resolveDpt5001Semantic({ dpt: "5.001", comObjectText: "Blind Position", applicationProgramHint: "Blind Actuator 4-fold" });
    expect(result.semantic).toBe("position");
    expect(result.confidence).toBe("high");
  });

  it("3: resolves a generic percentage GA to 'unknown' rather than fabricating brightness — no coordinating keyword anywhere", () => {
    const result = resolveDpt5001Semantic({ dpt: "5.001", comObjectText: "Value", gaName: "Channel 1 Value" });
    expect(result.semantic).toBe("unknown");
    expect(result.confidence).toBe("low");
  });

  it("4: DPT alone, zero evidence sources at all, resolves 'unknown' — never fabricated", () => {
    const result = resolveDpt5001Semantic({ dpt: "5.001" });
    expect(result.semantic).toBe("unknown");
    expect(result.confidence).toBe("low");
    expect(result.evidence).toEqual([]);
  });

  it("5: strong communication-object text overrides a generic/misleading Group Address name", () => {
    // GA name says nothing useful ("Channel 3"); the comm object's own function text is
    // the stronger, tier-2 source and must win.
    const result = resolveDpt5001Semantic({ dpt: "5.001", comObjectText: "Absolute Position", gaName: "Channel 3" });
    expect(result.semantic).toBe("position");
    expect(result.confidence).toBe("high");
  });

  it("6: application-program/device metadata (tier 1, strongest) overrides generic object text", () => {
    // The comm object's own text is bare ("Value" — no keyword match at all), but the
    // application-program hint (device model) resolves it.
    const result = resolveDpt5001Semantic({ dpt: "5.001", comObjectText: "Value", applicationProgramHint: "Dimming Actuator 300W" });
    expect(result.semantic).toBe("brightness");
    expect(result.confidence).toBe("high");
  });

  it("7: DPT alone is never sufficient — a non-5.001 DPT is explicitly out of scope for this resolver, and 5.001 with zero evidence is 'unknown', never assumed", () => {
    expect(resolveDpt5001Semantic({ dpt: "1.001", comObjectText: "Switch" }).semantic).toBe("unknown");
    expect(resolveDpt5001Semantic({ dpt: "5.001" }).semantic).toBe("unknown");
  });

  it("falls back to GroupRange context (tier 4, weakest) only when nothing stronger resolved anything", () => {
    const result = resolveDpt5001Semantic({ dpt: "5.001", comObjectText: "Value", gaName: "Channel 2", groupRangeContext: "Curtains" });
    expect(result.semantic).toBe("position");
    expect(result.confidence).toBe("medium");
  });

  it("is deterministic — identical input always produces identical output, order-independent", () => {
    const input = { dpt: "5.001", comObjectText: "Absolute Brightness Value", gaName: "Living Room Light Brightness", groupRangeContext: "Lightings" };
    const a = resolveDpt5001Semantic(input);
    const b = resolveDpt5001Semantic({ ...input });
    expect(a).toEqual(b);
  });

  it("§ real Juhu false positive, caught before integration — a GA literally named \"Curtain LED Strip Brightness Value\" is a LIGHT located near a curtain, not a blind; \"Curtain\" (location) and \"Brightness Value\" (function) both matching in the same text is CONTRADICTORY evidence, not proof of position, and must resolve unknown rather than picking one arbitrarily", () => {
    const result = resolveDpt5001Semantic({ dpt: "5.001", gaName: "Curtain LED Strip Brightness Value" });
    expect(result.semantic).toBe("unknown");
    expect(result.confidence).toBe("low");
  });

  it("the same contradictory-text guard applies to comObjectText, not just gaName", () => {
    const result = resolveDpt5001Semantic({ dpt: "5.001", comObjectText: "Curtain DL-5+6 Brightness Value" });
    expect(result.semantic).toBe("unknown");
  });
});

describe("classifyEtsSignal — safe DPT 5.001 production integration (Pass 7)", () => {
  it("overrides the default brightness classification to position for a HIGH-confidence, unambiguous position GA name", () => {
    const result = classifyEtsSignal("5.001", "circuit-key", "Blind Position");
    expect(result.capabilities).toEqual(["position"]);
  });

  it("keeps the existing brightness default for an ambiguous GA name (§ the real Juhu false positive) — never reclassifies on contradictory evidence", () => {
    const result = classifyEtsSignal("5.001", "circuit-key", "Curtain LED Strip Brightness Value");
    expect(result.capabilities).toEqual(["brightness"]);
  });

  it("keeps the existing brightness default when there is no position evidence at all", () => {
    const result = classifyEtsSignal("5.001", "circuit-key", "Living Room Dimmer");
    expect(result.capabilities).toEqual(["brightness"]);
  });

  it("never fabricates a 'speed' or 'percentage' capability — no SupremeOS capability supports them yet, so a speed-worded 5.001 GA still falls back to the existing brightness default rather than inventing one", () => {
    const result = classifyEtsSignal("5.001", "circuit-key", "Fan Speed Value");
    expect(result.capabilities).toEqual(["brightness"]); // unchanged from pre-Pass-7 behavior — disclosed, not fabricated
  });

  it("non-5.001 DPTs are completely unaffected by this integration", () => {
    expect(classifyEtsSignal("1.001", "circuit-key", "Switch").capabilities).toEqual(["onoff"]);
    expect(classifyEtsSignal("1.008", "circuit-key", "Up/Down").capabilities).toEqual(["position"]);
  });
});

// § P0-C (Pass 28) — single evidence function shared by planBindings (discovery/review
// time) and SupremeKnxDriver.getCapabilityConfig (runtime, once bound) so both stages
// agree on the same real-DPT-derived answer, never two independently-guessed ones.
describe("colorModesFromDpt", () => {
  it("DPT 7.x (percentage-scaled Kelvin) resolves CCT-only", () => {
    expect(colorModesFromDpt("7.600")).toEqual({ rgb: false, cct: true });
    expect(colorModesFromDpt("DPT7.600")).toEqual({ rgb: false, cct: true });
  });

  it("DPT 9.x (2-byte float, incl. absolute Kelvin) resolves CCT-only", () => {
    expect(colorModesFromDpt("9.22")).toEqual({ rgb: false, cct: true });
  });

  it("DPT 232.x (HSV) / 233.x (RGB) / 251.x (RGBW) resolve RGB-only", () => {
    expect(colorModesFromDpt("232.600")).toEqual({ rgb: true, cct: false });
    expect(colorModesFromDpt("233.600")).toEqual({ rgb: true, cct: false });
    expect(colorModesFromDpt("251.600")).toEqual({ rgb: true, cct: false });
  });

  it("an unrecognized DPT resolves null — never guessed", () => {
    expect(colorModesFromDpt("5.001")).toBeNull();
    expect(colorModesFromDpt("1.001")).toBeNull();
  });

  it("no DPT at all resolves null", () => {
    expect(colorModesFromDpt(null)).toBeNull();
    expect(colorModesFromDpt(undefined)).toBeNull();
    expect(colorModesFromDpt("")).toBeNull();
  });
});
