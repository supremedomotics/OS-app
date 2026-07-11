import { describe, expect, it } from "vitest";
import { applyLearnedNames, learnRenames } from "./learning-store.js";
import type { RecognizedDevice } from "./types.js";

function device(overrides: Partial<RecognizedDevice> = {}): RecognizedDevice {
  return {
    fingerprint: "ga:GA-1",
    name: "Living Spot 1",
    sourceName: "Living Spot 1",
    deviceType: "light_switch",
    supremeType: "switch",
    room: null,
    floor: null,
    building: null,
    manufacturer: null,
    product: null,
    bindings: [],
    sourceGroupAddressIds: ["GA-1"],
    sourceDeviceInstanceId: null,
    confidence: 0.6,
    ...overrides,
  };
}

describe("KNX learning engine", () => {
  it("learns a rename only when the saved name differs from what fresh recognition would produce", () => {
    const learned = learnRenames(
      [
        { fingerprint: "ga:GA-1", name: "Dining Spot", sourceName: "Living Spot 1" },
        { fingerprint: "ga:GA-2", name: "Living Spot 1", sourceName: "Living Spot 1" }, // unchanged
      ],
      [],
      "2026-01-01T00:00:00.000Z",
    );
    expect(learned).toEqual([{ fingerprint: "ga:GA-1", name: "Dining Spot", learnedAt: "2026-01-01T00:00:00.000Z" }]);
  });

  it("applies a learned rename on the next preview", () => {
    const devices = [device({ fingerprint: "ga:GA-1", name: "Living Spot 1" })];
    const applied = applyLearnedNames(devices, [
      { fingerprint: "ga:GA-1", name: "Dining Spot", learnedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(applied[0]?.name).toBe("Dining Spot");
  });

  it("leaves devices with no learned entry untouched", () => {
    const devices = [device({ fingerprint: "ga:GA-9", name: "Untouched" })];
    const applied = applyLearnedNames(devices, [
      { fingerprint: "ga:GA-1", name: "Dining Spot", learnedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(applied[0]?.name).toBe("Untouched");
  });

  it("replaces a prior learned entry for the same fingerprint rather than duplicating it", () => {
    const learned = learnRenames(
      [{ fingerprint: "ga:GA-1", name: "Kitchen Spot", sourceName: "Living Spot 1" }],
      [{ fingerprint: "ga:GA-1", name: "Dining Spot", learnedAt: "2025-01-01T00:00:00.000Z" }],
      "2026-01-01T00:00:00.000Z",
    );
    expect(learned).toEqual([{ fingerprint: "ga:GA-1", name: "Kitchen Spot", learnedAt: "2026-01-01T00:00:00.000Z" }]);
  });
});
