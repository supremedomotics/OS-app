import { describe, expect, it } from "vitest";
import { explainMerge, flattenMergedMetadata, mergeMetadata } from "./metadata-merge.js";
import { EMPTY_SEMANTIC_METADATA } from "./semantic-metadata.js";

describe("mergeMetadata", () => {
  it("prefers user override over every other source for the same field", () => {
    const merged = mergeMetadata([
      { kind: "grouping", metadata: { deviceName: "kitchen light" } },
      { kind: "ets", metadata: { deviceName: "ETS Kitchen Light", room: "Kitchen" } },
      { kind: "knx_iot", metadata: { deviceName: "IoT Kitchen Light" } },
      { kind: "user", metadata: { deviceName: "My Kitchen Light" } },
    ]);
    expect(merged.deviceName).toEqual({ value: "My Kitchen Light", source: "user" });
    expect(merged.room).toEqual({ value: "Kitchen", source: "ets" });
  });

  it("falls through the priority chain when higher sources are null/absent for a field", () => {
    const merged = mergeMetadata([
      { kind: "ets", metadata: {} },
      { kind: "knx_iot", metadata: {} },
      { kind: "grouping", metadata: { deviceName: "kitchen light" } },
      { kind: "inference", metadata: { deviceName: "Kitchen Light (Light)" } },
    ]);
    expect(merged.deviceName).toEqual({ value: "kitchen light", source: "grouping" });
  });

  it("never wins on an empty string — falls through as if absent", () => {
    const merged = mergeMetadata([
      { kind: "knx_iot", metadata: { deviceName: "" } },
      { kind: "ets", metadata: { deviceName: "ETS Name" } },
    ]);
    expect(merged.deviceName).toEqual({ value: "ETS Name", source: "ets" });
  });

  it("flattens and explains every winning field", () => {
    const merged = mergeMetadata([{ kind: "ets", metadata: { deviceName: "Kitchen Light", room: "Kitchen" } }]);
    expect(flattenMergedMetadata(merged)).toMatchObject({ ...EMPTY_SEMANTIC_METADATA, deviceName: "Kitchen Light", room: "Kitchen" });
    expect(explainMerge(merged)).toEqual(['deviceName: "Kitchen Light" ← ets', 'room: "Kitchen" ← ets']);
  });
});
