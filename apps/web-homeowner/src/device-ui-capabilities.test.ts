import { describe, expect, it } from "vitest";
import { anyDeviceHas, getDeviceUiCapabilities, getRoomUiCapabilities } from "./device-ui-capabilities.js";

/**
 * Capability matrix (§ ADR 0016 — Capability-Driven UI Architecture). Guards the exact
 * regression class found live this session: a device/room showing a control (RGB wheel, CCT
 * slider, …) its actual capabilities never declared. Runs against the shared
 * `getDeviceUiCapabilities()` / `getRoomUiCapabilities()` every page must consume, so a future
 * page can't silently reintroduce its own wrong capability check.
 */
function caps(kinds: string[]) {
  return kinds.map((kind) => ({ kind })) as { kind: import("@supreme/domain-model").CapabilityKind }[];
}

/** A `color` capability carrying structural, driver-normalized colorModes config (§ ADR 0017) —
 * as a real driver (e.g. Casambi via `colorConfigFromUnit()`) would populate at discovery time,
 * never from state. */
function capsWithColorConfig(otherKinds: string[], colorModes: { rgb: boolean; cct: boolean }) {
  return [
    ...caps(otherKinds),
    { kind: "color", config: { colorModes } },
  ] as { kind: import("@supreme/domain-model").CapabilityKind; config?: Record<string, unknown> }[];
}

describe("getDeviceUiCapabilities — single-device matrix", () => {
  it("1. onoff → power only", () => {
    const c = getDeviceUiCapabilities(caps(["onoff"]));
    expect(c).toMatchObject({ showPower: true, showBrightness: false, showRGB: false, showCCT: false });
  });

  it("2. onoff + brightness → power + dimmer, no colour controls", () => {
    const c = getDeviceUiCapabilities(caps(["onoff", "brightness"]));
    expect(c).toMatchObject({ showPower: true, showBrightness: true, showRGB: false, showCCT: false });
  });

  it("3. onoff + brightness + cct-only colour state → power + dimmer + CCT, no RGB", () => {
    const c = getDeviceUiCapabilities(caps(["onoff", "brightness", "color"]), { kelvin: 3000 });
    expect(c).toMatchObject({ showPower: true, showBrightness: true, showRGB: false, showCCT: true });
  });

  it("4. onoff + brightness + rgb-only colour state → power + dimmer + RGB, no CCT", () => {
    const c = getDeviceUiCapabilities(caps(["onoff", "brightness", "color"]), { hue: 200, saturation: 50 });
    expect(c).toMatchObject({ showPower: true, showBrightness: true, showRGB: true, showCCT: false });
  });

  it("5. onoff + brightness + rgb+cct colour state → power + dimmer + RGB + CCT", () => {
    const c = getDeviceUiCapabilities(caps(["onoff", "brightness", "color"]), { hue: 10, saturation: 80, kelvin: 4000 });
    expect(c).toMatchObject({ showPower: true, showBrightness: true, showRGB: true, showCCT: true });
  });

  it("regression guard: a device with NO `color` capability never shows RGB/CCT, however its state reads", () => {
    const dimmerOnly = getDeviceUiCapabilities(caps(["onoff", "brightness"]), undefined);
    expect(dimmerOnly.showRGB).toBe(false);
    expect(dimmerOnly.showCCT).toBe(false);
  });

  it("non-lighting capabilities are structural pass-throughs", () => {
    expect(getDeviceUiCapabilities(caps(["position"])).showPosition).toBe(true);
    expect(getDeviceUiCapabilities(caps(["fan"])).showFan).toBe(true);
    expect(getDeviceUiCapabilities(caps(["temperature"])).showClimate).toBe(true);
    expect(getDeviceUiCapabilities(caps(["lock"])).showLock).toBe(true);
    expect(getDeviceUiCapabilities(caps(["media"])).showMedia).toBe(true);
    expect(getDeviceUiCapabilities(caps(["sensor"])).showSensor).toBe(true);
    expect(getDeviceUiCapabilities(caps(["onoff"])).showPosition).toBe(false);
  });
});

describe("§ Step 4 — capability/state separation: missing state NEVER hides a capability-backed control", () => {
  it("RGB capability, no RGB state reported yet → RGB control still visible", () => {
    const c = getDeviceUiCapabilities(caps(["onoff", "brightness", "color"]), undefined);
    expect(c.showRGB).toBe(true); // safe default: has `color`, nothing reported yet → assume both
    expect(c.showCCT).toBe(true);
  });

  it("CCT capability, no kelvin reported yet → CCT control still visible (same safe default)", () => {
    const c = getDeviceUiCapabilities(caps(["color"]), null);
    expect(c.showCCT).toBe(true);
  });

  it("Brightness capability, no brightness state at all → brightness control still visible", () => {
    const c = getDeviceUiCapabilities(caps(["onoff", "brightness"]));
    expect(c.showBrightness).toBe(true); // presence-only — never conditioned on a state value existing
  });

  it("a capability the device does NOT have is never shown regardless of what garbage state might exist", () => {
    // `color` state present in the merged state object, but the device's OWN capability list
    // doesn't declare `color` — capability array is the only source of truth, not state shape.
    const c = getDeviceUiCapabilities(caps(["onoff", "brightness"]), { hue: 10, saturation: 50, kelvin: 3000 });
    expect(c.showRGB).toBe(false);
    expect(c.showCCT).toBe(false);
  });
});

describe("Room-level aggregate capability matrix (§ Room-Level Aggregate Controls)", () => {
  it("Room A — dimmer-only lights: no RGB, no CCT", () => {
    const perDevice = [
      getDeviceUiCapabilities(caps(["onoff", "brightness"])),
      getDeviceUiCapabilities(caps(["onoff", "brightness"])),
    ];
    const room = getRoomUiCapabilities(perDevice);
    expect(room.showRGB).toBe(false);
    expect(room.showCCT).toBe(false);
    expect(room.showBrightness).toBe(true);
    expect(anyDeviceHas(perDevice, "showRGB")).toBe(false);
  });

  it("Room B — CCT lights only: CCT shown, RGB not", () => {
    const perDevice = [getDeviceUiCapabilities(caps(["onoff", "brightness", "color"]), { kelvin: 3500 })];
    const room = getRoomUiCapabilities(perDevice);
    expect(room.showCCT).toBe(true);
    expect(room.showRGB).toBe(false);
  });

  it("Room C — RGB lights only: RGB shown, CCT not (unless genuinely supported)", () => {
    const perDevice = [getDeviceUiCapabilities(caps(["onoff", "brightness", "color"]), { hue: 300, saturation: 90 })];
    const room = getRoomUiCapabilities(perDevice);
    expect(room.showRGB).toBe(true);
    expect(room.showCCT).toBe(false);
  });

  it("Room D — RGB+CCT lights: both shown", () => {
    const perDevice = [getDeviceUiCapabilities(caps(["onoff", "brightness", "color"]), { hue: 5, saturation: 40, kelvin: 2900 })];
    const room = getRoomUiCapabilities(perDevice);
    expect(room.showRGB).toBe(true);
    expect(room.showCCT).toBe(true);
  });

  it("Room E — mixed dimmer + CCT + RGB: aggregate shows both, but each device's own flags still discriminate which devices a command may target", () => {
    const dimmerOnly = getDeviceUiCapabilities(caps(["onoff", "brightness"]));
    const cctLight = getDeviceUiCapabilities(caps(["onoff", "brightness", "color"]), { kelvin: 3000 });
    const rgbLight = getDeviceUiCapabilities(caps(["onoff", "brightness", "color"]), { hue: 120, saturation: 70 });
    const perDevice = [dimmerOnly, cctLight, rgbLight];
    const room = getRoomUiCapabilities(perDevice);

    expect(room.showRGB).toBe(true);
    expect(room.showCCT).toBe(true);

    // A room-wide RGB command must only ever target devices whose OWN flag is true — the
    // dimmer-only and CCT-only lights are correctly excluded from the RGB target set.
    expect(perDevice.filter((c) => c.showRGB)).toEqual([rgbLight]);
    expect(perDevice.filter((c) => c.showCCT)).toEqual([cctLight]);
    expect(perDevice.filter((c) => c.showBrightness)).toHaveLength(3);
  });
});

describe("§ ADR 0017 — Capability Normalization: structural config wins over state inference", () => {
  it("a Casambi-shaped device (colorModes config from colorConfigFromUnit) resolves RGB/CCT with ZERO state — colorModeConfirmed true", () => {
    const c = getDeviceUiCapabilities(capsWithColorConfig(["onoff", "brightness"], { rgb: false, cct: true }), undefined);
    expect(c.showRGB).toBe(false);
    expect(c.showCCT).toBe(true);
    expect(c.colorModeConfirmed).toBe(true); // known from the driver, not guessed
  });

  it("a KNX-shaped device with structural colorModes config behaves identically to a Casambi-shaped one — the UI never knows which protocol produced it", () => {
    const knxLike = getDeviceUiCapabilities(capsWithColorConfig(["onoff", "brightness"], { rgb: true, cct: false }), undefined);
    const casambiLike = getDeviceUiCapabilities(capsWithColorConfig(["onoff", "brightness"], { rgb: true, cct: false }), { hue: 999, saturation: 999 }); // irrelevant/garbage state — config wins
    expect(knxLike).toEqual(casambiLike);
  });

  it("Matter/Zigbee/DALI-shaped devices use the SAME generic structural path — no protocol-specific branch exists in the helper", () => {
    const matterLike = getDeviceUiCapabilities(capsWithColorConfig(["onoff", "brightness"], { rgb: true, cct: true }));
    const zigbeeLike = getDeviceUiCapabilities(capsWithColorConfig(["onoff", "brightness"], { rgb: true, cct: true }));
    const daliLike = getDeviceUiCapabilities(capsWithColorConfig(["onoff", "brightness"], { rgb: false, cct: true }));
    expect(matterLike).toEqual(zigbeeLike);
    expect(daliLike.showRGB).toBe(false);
    expect(daliLike.showCCT).toBe(true);
  });

  it("legacy driver compatibility: a `color` capability with NO config (old drivers, unmodified) falls back to state inference exactly as before — colorModeConfirmed false", () => {
    const legacy = getDeviceUiCapabilities(caps(["onoff", "brightness", "color"]), { kelvin: 3000 });
    expect(legacy.showCCT).toBe(true);
    expect(legacy.showRGB).toBe(false);
    expect(legacy.colorModeConfirmed).toBe(false); // inferred, not driver-confirmed
  });

  it("unknown mode (§ Step 4): no config AND no state at all → safe neutral default (both shown), never fabricated single-mode support, and explicitly marked unconfirmed", () => {
    const unknown = getDeviceUiCapabilities(caps(["color"]), undefined);
    expect(unknown.showRGB).toBe(true);
    expect(unknown.showCCT).toBe(true);
    expect(unknown.colorModeConfirmed).toBe(false);
  });

  it("RGB only / CCT only / RGB+CCT / brightness only — the four structural-config shapes", () => {
    expect(getDeviceUiCapabilities(capsWithColorConfig([], { rgb: true, cct: false }))).toMatchObject({ showRGB: true, showCCT: false });
    expect(getDeviceUiCapabilities(capsWithColorConfig([], { rgb: false, cct: true }))).toMatchObject({ showRGB: false, showCCT: true });
    expect(getDeviceUiCapabilities(capsWithColorConfig([], { rgb: true, cct: true }))).toMatchObject({ showRGB: true, showCCT: true });
    expect(getDeviceUiCapabilities(caps(["onoff", "brightness"]))).toMatchObject({ showBrightness: true, showRGB: false, showCCT: false });
  });
});
