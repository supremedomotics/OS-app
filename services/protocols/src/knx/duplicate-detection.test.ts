import { describe, expect, it } from "vitest";
import { bucketByDuplicateDecision, checkDuplicate, type ExistingInstallationState } from "./duplicate-detection.js";
import { mapUnifiedDevices } from "./unified-device-mapper.js";

const EMPTY: ExistingInstallationState = { backendIds: new Set(), boundAddresses: new Set(), groupingKeys: new Set() };

describe("checkDuplicate", () => {
  it("classifies a genuinely new device as new", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Kitchen Light" }] })[0]!;
    expect(checkDuplicate(device, EMPTY)).toMatchObject({ decision: "new" });
  });

  it("classifies a re-discovered device (same backendId) as update", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Kitchen Light" }] })[0]!;
    const existing: ExistingInstallationState = { ...EMPTY, backendIds: new Set([device.backendId]) };
    expect(checkDuplicate(device, existing)).toMatchObject({ decision: "update", matchedOn: "backendId" });
  });

  it("classifies full communication-object overlap as merge", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Kitchen Light" }] })[0]!;
    const existing: ExistingInstallationState = { ...EMPTY, boundAddresses: new Set(["1/1/1"]) };
    expect(checkDuplicate(device, existing)).toMatchObject({ decision: "merge", matchedOn: "communicationObject" });
  });

  it("escalates partial overlap to the installer rather than guessing", () => {
    const device = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Kitchen Light SW" }, { id: "1/1/2", name: "Kitchen Light STATUS" }],
    })[0]!;
    const existing: ExistingInstallationState = { ...EMPTY, boundAddresses: new Set(["1/1/1"]) };
    expect(checkDuplicate(device, existing)).toMatchObject({ decision: "ask_installer", matchedOn: "communicationObject" });
  });

  it("escalates a matching grouping key with no shared object to the installer (could be a rename)", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/9", name: "Kitchen Light" }] })[0]!;
    const existing: ExistingInstallationState = { ...EMPTY, groupingKeys: new Set(["kitchen light"]) };
    expect(checkDuplicate(device, existing)).toMatchObject({ decision: "ask_installer", matchedOn: "groupingKey" });
  });
});

describe("bucketByDuplicateDecision", () => {
  it("buckets a mixed batch into the Discover Devices workspace's sections", () => {
    const newDevice = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Kitchen Light" }] })[0]!;
    const dupeDevice = mapUnifiedDevices({ ets: [{ id: "1/1/2", name: "Hall Light" }] })[0]!;
    const existing: ExistingInstallationState = { ...EMPTY, boundAddresses: new Set(["1/1/2"]) };
    const buckets = bucketByDuplicateDecision([newDevice, dupeDevice], existing);
    expect(buckets.new).toHaveLength(1);
    expect(buckets.merge).toHaveLength(1);
    expect(buckets.ask_installer).toHaveLength(0);
  });
});
