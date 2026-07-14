import { describe, expect, it } from "vitest";
import { CONFIDENCE_REVIEW_THRESHOLD, fieldsNeedingReview, scoreConfidence } from "./confidence-engine.js";
import { mapUnifiedDevices } from "./unified-device-mapper.js";
import { parseFunctionalBlocks } from "./functional-block-parser.js";

describe("scoreConfidence", () => {
  it("scores a well-corroborated device (KNX IoT + ETS + multiple functional blocks) highly", () => {
    const { blocks } = parseFunctionalBlocks(
      '</fb/1/sw>;rt="urn:knx:fb.onoff";if="if.a";title="Kitchen Light",</fb/1/dim>;rt="urn:knx:fb.dim";if="if.a";title="Kitchen Light Dim"',
    );
    const device = mapUnifiedDevices({
      knxIot: [{ host: "10.0.0.42", linkFormat: '</dev>;title="Kitchen Light"', functionalBlocks: blocks }],
      ets: [{ id: "10.0.0.42", name: "Kitchen Light SW", room: "Kitchen" }],
    })[0]!;
    const scores = scoreConfidence(device);
    expect(scores.name).toBeGreaterThanOrEqual(85);
    expect(scores.capability).toBeGreaterThanOrEqual(70);
    expect(fieldsNeedingReview(scores)).not.toContain("name");
  });

  it("scores a bare grouping-only device lower and flags it for review", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Xyzzy Foo" }] })[0]!;
    const scores = scoreConfidence(device);
    expect(scores.capability).toBe(0); // no capability at all — Xyzzy Foo matches nothing
    expect(fieldsNeedingReview(scores).length).toBeGreaterThan(0);
    expect(scores.overall).toBeLessThan(CONFIDENCE_REVIEW_THRESHOLD);
  });

  it("never reports manufacturer/model confidence above 0 when nothing supplied them", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Kitchen Light" }] })[0]!;
    const scores = scoreConfidence(device);
    expect(scores.manufacturer).toBe(0);
    expect(scores.model).toBe(0);
  });
});
