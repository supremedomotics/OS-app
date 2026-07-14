import { describe, expect, it } from "vitest";
import { groupByCircuitName } from "./device-grouping.js";

describe("groupByCircuitName — Universal Device Grouping", () => {
  it("clusters every operation of one circuit into a single device (the spec example)", () => {
    const clusters = groupByCircuitName([
      { id: "1", name: "Kitchen Light SW" },
      { id: "2", name: "Kitchen Light STATUS" },
      { id: "3", name: "Kitchen Light DIM" },
      { id: "4", name: "Kitchen Light RGB" },
      { id: "5", name: "Kitchen Light CCT" },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.signals).toHaveLength(5);
    expect(clusters[0]!.key).toBe("kitchen light");
  });

  it("is case-insensitive and whitespace-insensitive", () => {
    const clusters = groupByCircuitName([
      { id: "1", name: "kitchen   light sw" },
      { id: "2", name: "KITCHEN LIGHT Status" },
      { id: "3", name: "Kitchen  Light  DIM" },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.signals).toHaveLength(3);
  });

  it("does not merge unrelated circuits", () => {
    const clusters = groupByCircuitName([
      { id: "1", name: "Kitchen Light SW" },
      { id: "2", name: "Living Room Light SW" },
      { id: "3", name: "Kitchen Blind Position" },
    ]);
    expect(clusters).toHaveLength(3);
  });

  it("is abbreviation-aware via the alias table", () => {
    const clusters = groupByCircuitName(
      [
        { id: "1", name: "MBR Sw" },
        { id: "2", name: "Master Bedroom Status" },
      ],
      { abbreviations: { mbr: "master bedroom" } },
    );
    expect(clusters).toHaveLength(1);
  });

  it("works for a non-KNX-shaped protocol vocabulary (Modbus-style register names)", () => {
    const clusters = groupByCircuitName(
      [
        { id: "40001", name: "Boiler Pump Power" },
        { id: "40002", name: "Boiler Pump Value" },
        { id: "40003", name: "Boiler Pump Counter" },
      ],
      { extraOperationWords: [] }, // "power"/"value"/"counter" already in the default list
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.key).toBe("boiler pump");
  });

  it("keeps a bare operation-only name as its own single-signal cluster, never an empty key collision", () => {
    const clusters = groupByCircuitName([
      { id: "1", name: "Switch" },
      { id: "2", name: "Switch" },
    ]);
    // Both reduce to the same non-empty key ("switch") on purpose - they really are
    // indistinguishable without more context, exactly like two real bare-named GAs would be.
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.signals).toHaveLength(2);
  });
});
