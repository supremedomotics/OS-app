import { describe, expect, it } from "vitest";
import { DeviceIntelError, validateDeviceIntel, validateDeviceIntelMap } from "./device.js";

describe("validateDeviceIntel", () => {
  it("accepts and normalizes a full record", () => {
    const intel = validateDeviceIntel({
      ownerUserId: "usr_1",
      sharedUserIds: ["usr_2"],
      priority: "high",
      expectedAlwaysOn: false,
      estimatedWatts: 75,
    });
    expect(intel.ownerUserId).toBe("usr_1");
    expect(intel.sharedUserIds).toEqual(["usr_2"]);
    expect(intel.estimatedWatts).toBe(75);
  });

  it("forces ignoreAutoPilot when critical", () => {
    expect(validateDeviceIntel({ critical: true }).ignoreAutoPilot).toBe(true);
  });

  it("rejects bad fields", () => {
    expect(() => validateDeviceIntel({ priority: "urgent" })).toThrow(DeviceIntelError);
    expect(() => validateDeviceIntel({ estimatedWatts: -1 })).toThrow(DeviceIntelError);
    expect(() => validateDeviceIntel({ estimatedWatts: 999999 })).toThrow(DeviceIntelError);
    expect(() => validateDeviceIntel({ sharedUserIds: "usr_1" })).toThrow(DeviceIntelError);
    expect(() => validateDeviceIntel({ critical: "yes" })).toThrow(DeviceIntelError);
  });

  it("validates a whole map", () => {
    const map = validateDeviceIntelMap({ dev_1: { estimatedWatts: 10 }, dev_2: { critical: true } });
    expect(Object.keys(map)).toEqual(["dev_1", "dev_2"]);
    expect(map.dev_2!.ignoreAutoPilot).toBe(true);
    expect(() => validateDeviceIntelMap([])).toThrow(DeviceIntelError);
  });
});
