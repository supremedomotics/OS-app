# SupremeOS Driver Author Guide

> How to write a new native protocol driver with the lifecycle contract correct from
> day one. Read [Driver-Lifecycle.md](./Driver-Lifecycle.md) and
> [Driver-SDK.md](./Driver-SDK.md) first — this is the checklist you apply while
> writing the code.

## Before you write anything

1. **Read an existing driver of the same shape first** (per `CLAUDE.md`'s "inspect
   before creating"). Pick the closest match from the table below — don't design your
   resource-cleanup story from scratch if a near-identical pattern already exists.
2. **Never invent a new capability vocabulary.** Route through `packages/domain-model
   /src/capabilities.ts`'s real capability set. If a control has no capability
   equivalent, that's an installer-entered `device.metadata` field, not a new
   capability.
3. **Never speak a protocol above this seam.** Everything above
   `INativeProtocolDriver` sees only Supreme capabilities — your driver is the ONLY
   place that knows the wire format.

## Step 1 — identify your resource shape

Ask: **"Does binding a second device to this driver create a second independent
connection, or does it share something with an existing binding?"**

| If your driver... | Use this pattern | Reference driver |
|---|---|---|
| Opens one connection per device, nothing shared | **1 — Simple** | `modbus-driver.ts`, `shelly-driver.ts` |
| Has a per-device client/player object from an injected library that needs explicit closing | **2 — Per-device close()** | `sonos-driver.ts` |
| Subscribes to a topic/address that more than one binding (possibly across devices) can share | **3 — Shared subscription key** | `mqtt-driver.ts`, `knx-driver.ts` |
| Opens one physical link per **host**, and multiple devices (zones, players) share that host | **4 — Shared host link** | `avr-driver.ts`, `heos-driver.ts` |
| Opens one client per device **address**, but a device's own capabilities can share that address's client | **Tuya variant** | `tuya-driver.ts` |

If you're not sure, default to pattern 1 and only add sharing logic once you actually
have a second binding that needs the same underlying resource — don't build
speculative sharing infrastructure for a resource that's always 1:1 (per `CLAUDE.md`:
"no unnecessary complexity, no speculative abstraction").

## Step 2 — write `bind()` and `unbind()` together, not `bind()` alone

Every resource `bind()` acquires needs a symmetric release in `unbind()`. Write them
side by side so the asymmetry is obvious if you miss one:

```ts
async bind(binding: ProtocolBinding): Promise<void> {
  // ...push a binding entry, add to `devices`, open/reuse a shared resource...
}

async manages(deviceId: DeviceId): boolean {
  return this.devices.has(deviceId);
}

/** § Driver Lifecycle Completion — releases this one device's <whatever bind()
 * acquired>, without touching a shared resource other devices still use. Idempotent. */
async unbind(deviceId: DeviceId): Promise<void> {
  // ...the exact mirror of bind()'s acquisition...
}
```

Place `unbind()` immediately after `manages()`, before `command()` — this is the
convention every driver in the fleet follows; keep the file's method ordering
consistent for anyone reading the next driver after yours.

## Step 3 — use the shared helpers, don't hand-roll

Import from `./binding-cleanup.js` (same package) for pattern 1/2:

```ts
import { removeDeviceBindings, removeDeviceStates } from "./binding-cleanup.js";

async unbind(deviceId: DeviceId): Promise<void> {
  removeDeviceBindings(this.bindings, deviceId);
  this.devices.delete(deviceId);
  removeDeviceStates(this.states, deviceId);
}
```

Don't write a new `for (let i = this.bindings.length - 1; i >= 0; i--) ...` splice loop
by hand — that's exactly the duplicated cleanup logic the platform audit was told to
find and eliminate. If your driver's shape doesn't fit these two helpers (patterns 3/4/
Tuya), the removal logic is still usually a small, self-contained loop — see
[Resource-Cleanup.md](./Resource-Cleanup.md) for the exact shape each pattern takes.

## Step 4 — reach for `DriverLifecycleController` only if it earns its keep

For most drivers (pattern 1/2), direct `Map`/`Set`/array manipulation in `unbind()` is
simpler and more readable than routing through `DriverLifecycleController` — there's
nothing to fail, no ordering dependency, no LIFO requirement. Skip it.

Reach for `DriverLifecycleController` when your driver's per-device resource graph has
**more than 2-3 things to release with a real ordering dependency between them**, or
when you want the fault-tolerant "one release failing doesn't block the rest"
guarantee for free:

```ts
import { DriverLifecycleController } from "@supreme/integration-layer";

class MyBinding {
  lifecycle = new DriverLifecycleController();
}

async bind(binding: ProtocolBinding): Promise<void> {
  const b = new MyBinding();
  const timer = setInterval(() => this.poll(b), 5000);
  b.lifecycle.registerCleanup(() => clearInterval(timer));
  const unsub = this.bus.observe(binding.address, (v) => this.onValue(b, v));
  b.lifecycle.registerCleanup(unsub);
  this.bindings.set(binding.deviceId, b);
}

async unbind(deviceId: DeviceId): Promise<void> {
  const b = this.bindings.get(deviceId);
  if (!b) return; // idempotent — already gone
  await b.lifecycle.runCleanups();
  this.bindings.delete(deviceId);
  removeDeviceStates(this.states, deviceId);
}
```

## Step 5 — if you subscribe to anything, make sure you CAN unsubscribe

This is the single most common way a new driver would repeat a bug the audit found and
fixed (see [Resource-Cleanup.md](./Resource-Cleanup.md) bug #2). Before you write
`bind()`, check: **does the transport/library method you're calling to subscribe
(`observe`, `subscribe`, `onEvent`, `onMessage`...) give you back a way to unsubscribe
just that one handler?**

- If it returns an unsubscribe function or takes a handler reference you can pass back
  to a `removeListener`-style call — good, store it per-binding and call it in
  `unbind()`.
- If it returns `void` and there's no way to remove a single handler — **fix the
  transport interface before writing the driver**, the way `MatterController.subscribe`
  and `KnxConnection.observe` were fixed to return `(): void`. Don't ship a driver whose
  `unbind()` can't actually stop a subscription from firing.
- If the underlying library's `unsubscribe`/`off` call is scoped more broadly than one
  binding (e.g. KNX's real `IKnxProvider.unsubscribe(groupAddress)`, which tears down
  *every* subscriber on that address) — check whether any other binding still needs
  that same key before calling it. See pattern 3 in
  [Resource-Cleanup.md](./Resource-Cleanup.md).

## Step 6 — check `disconnect()` too, not just `unbind()`

`disconnect()` is the whole-driver teardown (protocol disabled/uninstalled, hub
shutting down) — it's a *different* trigger from `unbind()` (one device removed), but
it must release the same categories of resource for every remaining binding. The audit
found three drivers (AirPlay, Apple TV, Sonos) whose `disconnect()` cleared a shared
timer but silently left `bindings`/`devices`/`states` populated and never closed
per-device transport handles at all. When you write `unbind()`, ask the same question
of `disconnect()`: does it release everything `bind()` acquired, for every device, not
just the shared resource?

## Step 7 — write the regression tests

At minimum, for a new driver:

1. **Basic unbind**: bind a device, verify `manages()`/`getState()` reflect it; unbind;
   verify both are false/null.
2. **Idempotency**: call `unbind()` twice; the second call must not throw.
3. **Shared-resource isolation** (patterns 2/3/4/Tuya only): bind two devices that share
   the resource; unbind one; assert the shared resource is *still* live and the
   remaining device's state/commands still work; unbind the second; assert the shared
   resource is *now* released.
4. **Rebind**: unbind, then bind the same device again on the **same driver instance**
   (never construct a new driver object in the test); assert it works exactly as a
   fresh bind would.

Use a real embedded/in-process fake for the transport wherever the rest of the fleet
does (aedes for MQTT, an in-process `net`/`http` server for TCP/HTTP drivers, a
fake object satisfying the injectable client interface for library-seam drivers) — this
codebase's convention is real transports over mocks; see `avr-driver.test.ts`'s
`startFakeAvr()` or `mqtt-driver.test.ts`'s embedded-broker setup for the pattern.

## Checklist before you consider a new driver done

- [ ] `bind()` and `unbind()` are symmetric — everything acquired has a release path.
- [ ] `unbind()` uses `removeDeviceBindings`/`removeDeviceStates` unless your resource
      shape genuinely doesn't fit them.
- [ ] Every `subscribe`/`observe`/`onEvent`-style call you make can be individually
      unsubscribed — fix the transport interface first if it can't.
- [ ] A shared resource (link/topic/GA/client) is only released once no other binding
      still needs it.
- [ ] `disconnect()` releases the same categories of resource as `unbind()`, for every
      remaining binding.
- [ ] `unbind()` is idempotent and safe for a device this driver never managed.
- [ ] Tests cover: basic unbind, idempotency, shared-resource isolation (if
      applicable), and rebind on the same driver instance.
- [ ] `pnpm --filter @supreme/protocols typecheck` and the driver's own test file pass.
