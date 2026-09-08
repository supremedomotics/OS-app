import { describe, it, expect } from "vitest";
import type { DeviceCapability } from "@supreme/domain-model";
import { resolveMatterDeviceType } from "./matter-device-type-resolver.js";

function cap(kind: DeviceCapability["kind"], config: Record<string, unknown> = {}): DeviceCapability {
  return { kind, config };
}

describe("resolveMatterDeviceType — § Matter Bridge Phase 1 foundation", () => {
  it("onoff-only device -> On/Off Light (0x0100), the pre-existing behavior stays unchanged", () => {
    const r = resolveMatterDeviceType([cap("onoff")]);
    expect(r.outcome).toBe("SUPPORTED");
    expect(r.deviceType?.id).toBe(0x0100);
    expect(r.deviceType?.primaryCapability).toBe("onoff");
  });

  it("brightness (dimmer, no color) -> Dimmable Light (0x0101)", () => {
    const r = resolveMatterDeviceType([cap("onoff"), cap("brightness")]);
    expect(r.outcome).toBe("SUPPORTED");
    expect(r.deviceType?.id).toBe(0x0101);
  });

  it("§ the reported bug — a colour temperature light (color capability, colorModes.cct only) -> Color Temperature Light (0x010c), not skipped", () => {
    const r = resolveMatterDeviceType([cap("color", { colorModes: { rgb: false, cct: true } })]);
    expect(r.outcome).toBe("SUPPORTED");
    expect(r.deviceType?.id).toBe(0x010c);
    expect(r.deviceType?.name).toBe("Color Temperature Light");
  });

  it("color capability with colorModes.rgb -> Extended Color Light (0x010d)", () => {
    const r = resolveMatterDeviceType([cap("color", { colorModes: { rgb: true, cct: true } })]);
    expect(r.outcome).toBe("SUPPORTED");
    expect(r.deviceType?.id).toBe(0x010d);
  });

  it("color capability with NO declared colorModes (driver hasn't adopted structural reporting) resolves to the NARROWER Color Temperature Light, never over-claims RGB", () => {
    const r = resolveMatterDeviceType([cap("color")]);
    expect(r.outcome).toBe("SUPPORTED");
    expect(r.deviceType?.id).toBe(0x010c);
  });

  it("§ the reported bug — a curtain motor (position capability, no onoff at all) -> Window Covering (0x0202), not skipped", () => {
    const r = resolveMatterDeviceType([cap("position")]);
    expect(r.outcome).toBe("SUPPORTED");
    expect(r.deviceType?.id).toBe(0x0202);
    expect(r.deviceType?.name).toBe("Window Covering");
  });

  it("position takes priority over onoff when a covering device happens to also report onoff", () => {
    const r = resolveMatterDeviceType([cap("onoff"), cap("position")]);
    expect(r.deviceType?.id).toBe(0x0202);
  });

  it("a device with none of the Phase 1 capabilities (e.g. a lock or a sensor) is UNSUPPORTED with a stated reason, never crashes and never returns a device type", () => {
    const r = resolveMatterDeviceType([cap("lock")]);
    expect(r.outcome).toBe("UNSUPPORTED");
    expect(r.deviceType).toBeNull();
    expect(r.reason).toBeTruthy();
  });

  it("a device with zero capabilities is UNSUPPORTED, not a crash", () => {
    const r = resolveMatterDeviceType([]);
    expect(r.outcome).toBe("UNSUPPORTED");
    expect(r.deviceType).toBeNull();
  });
});
