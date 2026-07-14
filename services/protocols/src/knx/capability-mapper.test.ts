import { describe, expect, it } from "vitest";
import { classifyFromText, classifyFunctionalBlock, mergeCapabilityHints } from "./capability-mapper.js";
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
