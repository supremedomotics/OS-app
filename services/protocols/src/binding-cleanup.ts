import type { DeviceId } from "@supreme/domain-model";

/**
 * Shared per-device binding/state cleanup helpers (§ Driver Lifecycle Completion,
 * Driver SDK). The overwhelming majority of drivers in this fleet share the exact
 * same three internal shapes — a `bindings: {deviceId, capability, ...}[]` array, a
 * `devices: Set<DeviceId>`, and a `states: Map<string, CapabilityState>` keyed by
 * `bindingKey(deviceId, capability)` (`"<deviceId>:<capability>"`, see
 * `protocols/driver.ts`) — so `unbind(deviceId)` is the same mechanical operation
 * everywhere: drop every entry for that device from all three. Extracted here once
 * new drivers get it automatically instead of re-deriving the same six lines.
 *
 * This does NOT release shared resources (a poll timer, a persistent socket) — those
 * are correctly released once, in `disconnect()`, when the WHOLE driver tears down,
 * because they're shared across every device the driver manages. A driver with a
 * genuinely per-device resource (its own socket, its own timer) needs its own
 * additional cleanup in `unbind()` beyond these helpers — see the AVR/HEOS/Yamaha
 * drivers' `unbind()` for that shape.
 */

/** Remove every binding entry for `deviceId`, in place, preserving order of the rest. */
export function removeDeviceBindings<B extends { deviceId: DeviceId }>(bindings: B[], deviceId: DeviceId): void {
  for (let i = bindings.length - 1; i >= 0; i--) {
    if (bindings[i]!.deviceId === deviceId) bindings.splice(i, 1);
  }
}

/** Remove every `bindingKey(deviceId, *)`-prefixed entry from a states map, in place. */
export function removeDeviceStates(states: Map<string, unknown>, deviceId: DeviceId): void {
  const prefix = `${deviceId}:`;
  for (const k of [...states.keys()]) {
    if (k.startsWith(prefix)) states.delete(k);
  }
}
