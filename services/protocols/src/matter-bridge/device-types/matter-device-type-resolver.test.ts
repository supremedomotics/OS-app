import { describe, it, expect } from "vitest";
import type { DeviceCapability } from "@supreme/domain-model";
import { resolveMatterDeviceType, resolveKeypadControlDeviceType } from "./matter-device-type-resolver.js";

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

  it("§ Matter Bridge Phase 2A — onoff-only device with deviceKind 'switch' -> On/Off Plug-in Unit (0x010a), not a Light", () => {
    const r = resolveMatterDeviceType([cap("onoff")], undefined, "switch");
    expect(r.outcome).toBe("SUPPORTED");
    expect(r.deviceType?.id).toBe(0x010a);
    expect(r.deviceType?.name).toBe("On/Off Plug-in Unit");
  });

  it("§ Matter Bridge Phase 2A — deviceKind 'light' (or omitted) keeps resolving onoff-only to On/Off Light — no regression for the pre-existing default", () => {
    expect(resolveMatterDeviceType([cap("onoff")], undefined, "light").deviceType?.id).toBe(0x0100);
    expect(resolveMatterDeviceType([cap("onoff")]).deviceType?.id).toBe(0x0100);
  });

  it("§ Matter Bridge Phase 2A — deviceKind 'switch' has no effect once the device has richer capabilities (brightness/color/position) — a dimmable switch is still a Dimmable Light, never demoted to a plug", () => {
    expect(resolveMatterDeviceType([cap("onoff"), cap("brightness")], undefined, "switch").deviceType?.id).toBe(0x0101);
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

describe("resolveKeypadControlDeviceType — § Matter Bridge Phase 2B (Test B: resolver test)", () => {
  it("a 'button' control resolves to Generic Switch (0x000f)", () => {
    const r = resolveKeypadControlDeviceType("button");
    expect(r.outcome).toBe("SUPPORTED");
    expect(r.deviceType?.id).toBe(0x000f);
    expect(r.deviceType?.name).toBe("Generic Switch");
  });

  it("a 'rotary_encoder'/'touch_zone'/'slider' control is UNSUPPORTED with a stated reason — a disclosed gap, never silently dropped or guessed", () => {
    for (const kind of ["rotary_encoder", "touch_zone", "slider"] as const) {
      const r = resolveKeypadControlDeviceType(kind);
      expect(r.outcome).toBe("UNSUPPORTED");
      expect(r.deviceType).toBeNull();
      expect(r.reason).toContain(kind);
    }
  });
});
