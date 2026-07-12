import type { CapabilityKind, Device } from "@supreme/domain-model";

/**
 * The Premium Device Experience Library's capability-availability engine (§ "the UI is the
 * contract; the capability engine and drivers satisfy it over time"). Every premium page can
 * show its full intended control set from day one; this is the ONE place that decides whether
 * each control is real today, so no module hardcodes protocol-specific logic to answer that
 * question itself.
 *
 * Three real outcomes, never a fourth invented one:
 *  - the device doesn't have the capability at all → "Driver required" (no protocol binding
 *    exists yet for this device to even attempt the control).
 *  - the device has the capability, but the specific config field this control needs isn't
 *    present → "Not supported by current driver" (the protocol genuinely doesn't report it).
 *  - both are present → available, render the real control.
 */
export type Availability = { available: true } | { available: false; reason: string };

const AVAILABLE: Availability = { available: true };
const NO_DRIVER: Availability = { available: false, reason: "Driver required" };
const UNSUPPORTED: Availability = { available: false, reason: "Not supported by current driver" };

/** Does this device have the given capability, and (optionally) does that capability's own
 * config carry the specific field a control needs? */
export function capabilityAvailability(device: Device, capability: CapabilityKind, configKey?: string): Availability {
  const cap = device.capabilities.find((c) => c.kind === capability);
  if (!cap) return NO_DRIVER;
  if (configKey && !(configKey in (cap.config ?? {}))) return UNSUPPORTED;
  return AVAILABLE;
}

/** Same question, phrased for a field that should exist in the device's live STATE rather than
 * its capability config (e.g. a `media` device reporting `volume`) — still real presence, never
 * a guess: state is only ever populated by an actual driver report. */
export function stateFieldAvailability(device: Device, capability: CapabilityKind, stateKey: string): Availability {
  const cap = device.capabilities.find((c) => c.kind === capability);
  if (!cap) return NO_DRIVER;
  const state = (device.state as Record<string, Record<string, unknown>> | undefined)?.[capability];
  if (!state || !(stateKey in state)) return UNSUPPORTED;
  return AVAILABLE;
}
