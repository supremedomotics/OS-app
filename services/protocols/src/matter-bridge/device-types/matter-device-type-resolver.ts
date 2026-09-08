import { ColorCapabilityConfig, type DeviceCapability } from "@supreme/domain-model";
import { matterDeviceTypeRegistry, type MatterDeviceTypeRegistry } from "./matter-device-type-registry.js";
import type { MatterDeviceTypeDefinition } from "./matter-device-types.js";

/**
 * Every endpoint the resolver considers must end in one of these — never a silent, unreported
 * absence from the bridge (§ Matter Bridge Phase 1 foundation, "Unsupported endpoints not
 * silently dropped"). `DEGRADED` and `UNKNOWN` are reserved for Phase 2's controller-side
 * (Matter→SupremeOS) resolver, where a REAL discovered endpoint can genuinely be missing a
 * mandatory cluster or carry a device type this registry has never heard of — neither case can
 * happen in Phase 1's bridge/outbound direction, where we are choosing a KNOWN Matter device
 * type to represent one of OUR OWN, fully-known SupremeOS devices. Declared here (not just in
 * Phase 1's own resolution type) so Phase 2 extends this exact enum rather than inventing a
 * second, incompatible outcome vocabulary.
 */
export type MatterEndpointOutcome = "SUPPORTED" | "DEGRADED" | "UNKNOWN" | "UNSUPPORTED";

export interface MatterDeviceTypeResolution {
  outcome: MatterEndpointOutcome;
  deviceType: MatterDeviceTypeDefinition | null;
  /** Present whenever `outcome !== "SUPPORTED"` — the installer-facing diagnostic reason
   * (§ Phase 1 acceptance: "diagnostics must explain why an endpoint is degraded or
   * unsupported"). Null only for a genuine SUPPORTED resolution. */
  reason: string | null;
}

function has(capabilities: DeviceCapability[], kind: DeviceCapability["kind"]): DeviceCapability | undefined {
  return capabilities.find((c) => c.kind === kind);
}

/**
 * SupremeOS capability set → Matter Device Type (§ Matter Bridge Phase 1 foundation — THE
 * architectural fix for the reported bug: this replaces `exposeOnOffDevices`'s
 * `capabilities.some(c => c.kind === "onoff")` filter, which silently skipped every Color
 * Temperature light and the curtain motor because neither carries a bare `onoff` entry).
 *
 * This is deliberately NOT a chain of `if (capability === "onoff") ... else if (...)` per-
 * capability branches (§ the explicit anti-pattern this Phase exists to remove) — it looks at
 * the COMPLETE capability set once and picks the single Matter Device Type whose real-world
 * semantics that set actually justifies, per the Matter 1.6 spec's own device definitions
 * (§ `matter-device-types.ts`'s doc comment): OnOff alone is a Light only when nothing richer is
 * present; a device that also dims is a Dimmable Light, not "an OnOff Light plus a bonus"; a
 * device with real color/color-temperature control is a Color-family light; a device reporting
 * `position` is a Window Covering regardless of whether it also happens to expose `onoff` (many
 * curtain/blind drivers do not, and Matter's Window Covering device type does not require OnOff
 * at all — confirmed against `@matter/node`'s own `window-covering.ts`).
 *
 * Order matters and is deliberate, most-specific first:
 *   1. `position` → Window Covering (a covering is never a light, regardless of what else it reports)
 *   2. `color` → Color Temperature Light or Extended Color Light, decided by the capability's
 *      OWN declared `colorModes` (§ `ColorCapabilityConfig` — never guessed from live state,
 *      which this resolver — a capability-declaration-time decision — doesn't even have access
 *      to). `colorModes` absent (a driver that hasn't adopted structural color-mode reporting
 *      yet) resolves to the NARROWER claim, Color Temperature Light — exposing a device as
 *      Extended Color Light promises real hue/saturation control the driver hasn't confirmed it
 *      can honor, which is worse than under-claiming.
 *   3. `brightness` → Dimmable Light
 *   4. `onoff` → On/Off Light
 *   5. none of the above → UNSUPPORTED, with a stated reason (never a silent skip)
 */
export function resolveMatterDeviceType(
  capabilities: DeviceCapability[],
  registry: MatterDeviceTypeRegistry = matterDeviceTypeRegistry,
): MatterDeviceTypeResolution {
  const position = has(capabilities, "position");
  if (position) {
    const deviceType = registry.byId(0x0202);
    if (!deviceType) return unsupportedRegistryGap(0x0202);
    return { outcome: "SUPPORTED", deviceType, reason: null };
  }

  const color = has(capabilities, "color");
  if (color) {
    const parsed = ColorCapabilityConfig.safeParse(color.config);
    const rgb = parsed.success && parsed.data.colorModes?.rgb === true;
    const id = rgb ? 0x010d : 0x010c;
    const deviceType = registry.byId(id);
    if (!deviceType) return unsupportedRegistryGap(id);
    return { outcome: "SUPPORTED", deviceType, reason: null };
  }

  const brightness = has(capabilities, "brightness");
  if (brightness) {
    const deviceType = registry.byId(0x0101);
    if (!deviceType) return unsupportedRegistryGap(0x0101);
    return { outcome: "SUPPORTED", deviceType, reason: null };
  }

  const onoff = has(capabilities, "onoff");
  if (onoff) {
    const deviceType = registry.byId(0x0100);
    if (!deviceType) return unsupportedRegistryGap(0x0100);
    return { outcome: "SUPPORTED", deviceType, reason: null };
  }

  return {
    outcome: "UNSUPPORTED",
    deviceType: null,
    reason:
      "No SupremeOS capability on this device maps to a Matter Bridge device type supported in " +
      "this phase (onoff, brightness, color, position) — sensors, locks, thermostats, fans, " +
      "media, and energy devices are not yet bridgeable (§ Phase 2-4).",
  };
}

function unsupportedRegistryGap(id: number): MatterDeviceTypeResolution {
  return {
    outcome: "UNSUPPORTED",
    deviceType: null,
    reason: `internal: device type 0x${id.toString(16)} is missing from the device-type registry — this is a bug, not a real capability gap`,
  };
}
