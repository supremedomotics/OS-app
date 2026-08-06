import { describe, expect, it } from "vitest";
import { classifyEtsSignal, classifyFromText, classifyFunctionalBlock, mergeCapabilityHints } from "./capability-mapper.js";
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
