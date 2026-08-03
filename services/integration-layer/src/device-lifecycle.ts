/**
 * Device lifecycle state (ADR-0023 § Native Device Lifecycle Architecture).
 *
 * Replaces every implicit simulated/fallback device state with an explicit,
 * honest machine. UNBOUND means exactly what it says — no driver, no state, no
 * fabricated values. OFFLINE (was bound, driver unreachable) and ERROR
 * (bind/health failure) are distinct from UNBOUND (never bound); nothing in this
 * codebase may collapse them into one another.
 */
export type DeviceLifecycleState =
  | "DISCOVERED"
  | "REGISTERED"
  | "UNBOUND"
  | "BINDING"
  | "BOUND"
  | "ONLINE"
  | "OFFLINE"
  | "ERROR"
  | "REMOVED";

/** Valid transitions — anything not listed here is rejected by {@link DriverBindingEngine}. */
export const DEVICE_LIFECYCLE_TRANSITIONS: Record<DeviceLifecycleState, DeviceLifecycleState[]> = {
  DISCOVERED: ["REGISTERED", "REMOVED"],
  REGISTERED: ["UNBOUND", "REMOVED"],
  UNBOUND: ["BINDING", "REMOVED"],
  BINDING: ["BOUND", "ERROR", "UNBOUND"],
  // BOUND/ONLINE/OFFLINE -> BINDING covers binding an ADDITIONAL capability (or a
  // rebind) on a device that already has one — a real device is bound one
  // capability/ProtocolBinding at a time, not all-at-once, so "already commandable,
  // binding one more capability" must be a legal transition, not a dead end.
  BOUND: ["ONLINE", "OFFLINE", "ERROR", "UNBOUND", "BINDING"],
  ONLINE: ["OFFLINE", "ERROR", "UNBOUND", "REMOVED", "BINDING"],
  OFFLINE: ["ONLINE", "ERROR", "UNBOUND", "REMOVED", "BINDING"],
  ERROR: ["BINDING", "UNBOUND", "REMOVED"],
  REMOVED: [],
};

export function canTransition(from: DeviceLifecycleState, to: DeviceLifecycleState): boolean {
  return DEVICE_LIFECYCLE_TRANSITIONS[from].includes(to);
}
