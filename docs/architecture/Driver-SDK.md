# SupremeOS Driver SDK

> The seam every native protocol driver implements: `INativeProtocolDriver`
> (`services/integration-layer/src/protocols/driver.ts`). This document covers the
> lifecycle-relevant surface — required methods, the optional `unbind()` contract, and
> the shared helpers every driver can reuse. For the full capability/command/state
> shape see `docs/architecture/avr-sdk-developer-guide.md` and `docs/drivers.md`.

## The interface

```ts
export interface INativeProtocolDriver {
  readonly protocol: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  bind(binding: ProtocolBinding): Promise<void>;
  manages(deviceId: DeviceId): boolean;

  command(deviceId: DeviceId, command: CapabilityCommand): Promise<void>;
  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null;

  discover(): Promise<DiscoveredDevice[]>;
  onState(listener: StateListener): () => void;

  // Optional — a driver implements what it can genuinely support; capabilities
  // never fabricated (§ CLAUDE.md "Never fabricate data or capabilities").
  getArtwork?(deviceId: DeviceId): Promise<ArtworkResult | null>;
  getQueue?(deviceId: DeviceId): Promise<MediaQueueItem[] | null>;
  getCapabilityConfig?(deviceId: DeviceId, capability: CapabilityKind): Record<string, unknown> | null;
  getDiagnostics?(deviceId: DeviceId): DriverDiagnosticsSnapshot | null;

  /**
   * Release EVERY resource this driver holds for ONE device, without disturbing any
   * other device this driver still manages. MUST be idempotent — calling it twice (or
   * on a device this driver never bound) MUST NOT throw, and MUST NOT double-release.
   * After this resolves, `manages(deviceId)` MUST return false and `getState()` for
   * this device MUST return null.
   */
  unbind?(deviceId: DeviceId): Promise<void>;
}
```

`unbind` is declared **optional** at the type level — same as `getArtwork`/`getQueue`/
`getCapabilityConfig`/`getDiagnostics` before it — deliberately, so adding it never
breaks a driver mid-migration. As of this effort it is implemented on **every** driver
in the fleet (see [Resource-Cleanup.md](./Resource-Cleanup.md)'s audit table), so in
practice it is mandatory; the optional-`?` stays because a *future* driver author who
skips it should get a working (if leaky) driver, not a compile error — the platform
degrades gracefully via `unbind?.()` at every call site, and the fleet-wide test suite
is what actually enforces compliance going forward, not the type system.

## Contract details for `unbind()`

1. **Idempotent.** A second call (or a call for a device already unbound, or a device
   this driver never managed) is a safe no-op. Never throw for "I don't know this
   device" — that's success, not an error, because the end state (this driver doesn't
   manage it) is already true.
2. **Scoped to one device.** Never tear down a shared resource (a TCP link, an MQTT
   client, a KNX bus connection) that another still-bound device needs. See
   [Resource-Cleanup.md](./Resource-Cleanup.md) for the exact "only release the shared
   thing when the last reference is gone" pattern used across the fleet.
3. **Synchronous effects before the promise resolves**, from the caller's perspective:
   `manages(deviceId)` is `false` and `getState(deviceId, cap)` is `null` for every
   capability the moment `unbind()`'s promise settles — not eventually.
4. **Never let one release step's failure block the rest.** If a driver releases
   multiple things (a subscription AND a queued command AND cached state), a failure
   in one must not skip the others. `DriverLifecycleController.runCleanups()` gives
   this for free if you use it; drivers that unbind by direct array/map manipulation
   get it for free too, since there's nothing to "fail" in a `Map.delete()`.

## `SupremeNativeAdapter.unbindDevice()`

The fleet-wide entry point above individual drivers
(`services/integration-layer/src/native-adapter.ts`):

```ts
async unbindDevice(deviceId: DeviceId): Promise<void> {
  const owner = this.ownerByDevice.get(deviceId);
  this.ownerByDevice.delete(deviceId);
  this.managed.delete(deviceId);
  const prefix = `${deviceId}:`;
  for (const k of [...this.states.keys()]) {
    if (k.startsWith(prefix)) this.states.delete(k);
  }
  if (owner?.unbind) await owner.unbind(deviceId);
}
```

This is what makes the whole platform tolerant of drivers that haven't (yet) got a real
`unbind()`: adapter-level bookkeeping (`ownerByDevice`, `managed`, cached `states`) is
always cleared regardless, and the driver's own `unbind?.()` is called *if it exists*.
A driver with no `unbind()` at all still gets forgotten at the SIL boundary — it just
doesn't get a chance to release its own internal resources, which is the leak this
whole effort closes, not a crash.

## Shared cleanup helpers

`services/protocols/src/binding-cleanup.ts` — extracted after the same 3-line pattern
was about to be duplicated across 8+ drivers with the "simple" resource shape (see
[Resource-Cleanup.md](./Resource-Cleanup.md)):

```ts
/** Remove every binding entry for `deviceId` from a flat bindings array, in place. */
export function removeDeviceBindings<B extends { deviceId: DeviceId }>(
  bindings: B[],
  deviceId: DeviceId,
): void;

/** Remove every cached-state entry keyed `${deviceId}:${capability}` for `deviceId`. */
export function removeDeviceStates(
  states: Map<string, unknown>,
  deviceId: DeviceId,
): void;
```

Both operate by exact `deviceId` match / key prefix — `removeDeviceStates` is guarded
against a false-positive prefix match (`"device-1"` vs `"device-10"`, see
`binding-cleanup.test.ts`) by relying on the fixed `bindingKey()` separator (`:`), not a
naive `startsWith`. Nearly every driver's `unbind()` is exactly:

```ts
async unbind(deviceId: DeviceId): Promise<void> {
  removeDeviceBindings(this.bindings, deviceId);
  this.devices.delete(deviceId);
  removeDeviceStates(this.states, deviceId);
}
```

Reach for these first. Only hand-roll cleanup logic when a driver's resource shape
genuinely isn't a flat `bindings` array + `states` map — see the topic-keyed (MQTT),
per-host-link (AVR/HEOS/Yamaha), and per-device-transport (Tuya) variations documented
in [Resource-Cleanup.md](./Resource-Cleanup.md).

## `DriverLifecycleController`

The state-machine + LIFO cleanup-registry primitive — see
[Driver-Lifecycle.md](./Driver-Lifecycle.md) for the full contract. Exported from
`@supreme/integration-layer`:

```ts
import {
  DriverLifecycleController,
  InvalidLifecycleTransitionError,
  type CleanupFn,
  type DriverLifecycleState,
} from "@supreme/integration-layer";
```

Available to every driver author; not mandatory for drivers whose resource graph is
simple enough that direct map/array cleanup is clearer (which is most of the current
fleet — see the Driver-Author-Guide for when to reach for it vs. when not to).

## `IBackendAdapter.unbindDevice?()`

The backend-agnostic seam above `SupremeNativeAdapter`
(`services/integration-layer/src/adapter.ts`), implemented by both
`SupremeNativeAdapter` and `RoutingBackendAdapter`
(`services/integration-layer/src/routing-adapter.ts`):

```ts
async unbindDevice(deviceId: DeviceId): Promise<void> {
  await this.native.unbindDevice(deviceId);
  await this.ha.unbindDevice?.(deviceId);
}
```

Runs on **both** sides unconditionally — deliberate over-cleaning as the safe failure
mode, since a device's true owner isn't always cheap to determine ahead of the call, and
calling `unbindDevice` on the wrong side is defined to be a no-op (per the contract
above), never an error.

## `SupremeIntegrationLayer.unmapDevice()`

The top-level entry point (`services/integration-layer/src/sil.ts`) — the fix that
closes the original gap:

```ts
async unmapDevice(deviceId: DeviceId): Promise<void> {
  if (this.adapter.unbindDevice) await this.adapter.unbindDevice(deviceId);
  this.registry.unmapDevice(deviceId);
  await this.ownership.clear(deviceId);
}
```

Before this effort, `unmapDevice()` only cleared SIL-level bookkeeping
(`registry`/`ownership`) — it never told the owning driver to release its own
resources. That's the root cause the whole platform-wide `unbind()` rollout exists to
fix.
