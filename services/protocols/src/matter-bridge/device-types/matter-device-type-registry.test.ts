import { describe, it, expect } from "vitest";
import { matterDeviceTypeRegistry } from "./matter-device-type-registry.js";

describe("MatterDeviceTypeRegistry — § Matter Bridge Phase 1 foundation", () => {
  it("resolves every Phase 1 device type by its real Matter spec id", () => {
    expect(matterDeviceTypeRegistry.byId(0x0100)?.name).toBe("On/Off Light");
    expect(matterDeviceTypeRegistry.byId(0x0101)?.name).toBe("Dimmable Light");
    expect(matterDeviceTypeRegistry.byId(0x010c)?.name).toBe("Color Temperature Light");
    expect(matterDeviceTypeRegistry.byId(0x010d)?.name).toBe("Extended Color Light");
    expect(matterDeviceTypeRegistry.byId(0x0202)?.name).toBe("Window Covering");
  });

  it("returns null for an id it doesn't know, never throws or fabricates a definition", () => {
    expect(matterDeviceTypeRegistry.byId(0xfeed)).toBeNull();
  });

  it("every definition's requiredServerClusters includes at least one cluster (nothing is a device type with zero requirements)", () => {
    for (const d of matterDeviceTypeRegistry.all()) {
      expect(d.requiredServerClusters.length).toBeGreaterThan(0);
    }
  });

  it("On/Off Light requires exactly Identify, Groups, OnOff, ScenesManagement (per @matter/node's own on-off-light.ts)", () => {
    const names = matterDeviceTypeRegistry.byId(0x0100)!.requiredServerClusters.map((c) => c.clusterName).sort();
    expect(names).toEqual(["Groups", "Identify", "OnOff", "ScenesManagement"]);
  });

  it("Window Covering does NOT require OnOff (a covering is not a light)", () => {
    const names = matterDeviceTypeRegistry.byId(0x0202)!.requiredServerClusters.map((c) => c.clusterName);
    expect(names).not.toContain("OnOff");
    expect(names).toContain("WindowCovering");
  });
});
