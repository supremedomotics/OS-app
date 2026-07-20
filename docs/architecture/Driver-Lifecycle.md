# SupremeOS Driver Lifecycle

> Platform-wide, mandatory for every driver — KNX, Matter, Zigbee, Z-Wave, BLE, AVRs,
> TVs, Projectors, DSPs, Matrix Switches, Cameras, Door Phones, HVAC, Lighting,
> Security, and every future driver. Not an AV-specific concept: it was discovered as a
> gap during the AVR production audit, but the fix lives at the platform seam
> (`@supreme/integration-layer`) and applies to all ~22 drivers in the fleet.

## Two lifecycles, deliberately not conflated

SupremeOS has **two** driver lifecycles at two different scopes. Confusing them is the
single easiest way to misdesign a cleanup path, so keep them separate in your head:

### 1. Orchestration lifecycle — one per protocol **instance**

`Create → Initialize → Register → Bind → Start → Stop → Unbind → Destroy`

This is the whole-driver boot/shutdown sequence: bringing a protocol driver (e.g. "the
KNX driver") up when the hub boots or a protocol is enabled, and tearing the whole
thing down when the protocol is disabled/uninstalled or the hub shuts down. It already
existed before this effort and is implemented in
`services/gateway/src/installer-context.ts`'s `runDriverLifecycle()` /
`DriverLifecycleStage` type:

```
registering → validating → restoring_bindings → rebinding_devices
  → recalculating_ownership → publishing → ready
                                          ↘ failed
```

Plus a teardown branch (`driver === null`) that now explicitly passes through a
`"stopping"` stage before `unregisterNativeProtocol()` — added so this transition is
observable in diagnostics, not just implicit.

**This lifecycle governs one driver INSTANCE, not individual devices.** A KNX driver
instance serves dozens of devices at once; disabling KNX tears down all of them
together. That's correct for "the whole protocol went away," but it was never built to
answer a different, narrower question: *"the homeowner deleted ONE device — what does
the driver need to release for just that device, while staying up for everyone else?"*
That's lifecycle #2.

### 2. Per-device lifecycle — one per device **binding**, within a still-running driver

```
Created → Initialized → Registered → Discovering → Discovered
  → Binding → Bound → Connecting → Connected
  → Capability Discovery → State Synchronization → Ready → Operational
  → Reconnecting ⇄ Disconnected
  → Unbinding → Unbound → Destroyed
```

This is the gap the AVR production audit found: **no driver implemented a complete
`unbind()`** for a single device while its driver instance kept running for every other
device. Deleting one HEOS speaker never released that speaker's share of the shared TCP
connection's bookkeeping; deleting one KNX light never unsubscribed its group address;
deleting one MQTT device never unsubscribed its topic. The driver only ever cleaned up
per-device state on a *whole-driver* `disconnect()` — which is the wrong trigger for
"one device was removed."

This is what `DriverLifecycleController` (below) and every driver's `unbind()` method
implement. A driver instance serves MANY devices — often sharing one physical link
(HEOS's one-socket-many-players pattern is the extreme case; AVR zones, Yamaha
multi-zone units, and KNX/Matter observers over a shared bus all share this shape to
varying degrees) — so each device's own position in this sequence is independent. A
`DriverLifecycleController` is created per device (or per physical link, when the link
itself is the natural unit — see the Driver Author Guide), not per driver instance.

## The 20 states

Defined in `services/integration-layer/src/protocols/lifecycle.ts` as
`DriverLifecycleState`:

| State | Meaning |
|---|---|
| `created` | The controller/binding object exists; nothing has happened yet. |
| `initialized` | Driver-level setup for this binding has run (rare to need explicitly — most drivers skip straight to `registered`/`binding`). |
| `registered` | The binding is known to the driver's bookkeeping (`devices`/`bindings` maps). |
| `discovering` | The driver is actively searching for this device on the wire (SSDP/mDNS/etc). |
| `discovered` | The device was found and its `DiscoveredDevice` descriptor exists. |
| `binding` | `bind()` is in progress for this device. |
| `bound` | A binding exists — `manages(deviceId)` returns `true`. **A real gate**: nothing below this should be commandable. |
| `connecting` | The underlying transport (socket/HTTP/bus) is being established for this device (or its shared link). |
| `connected` | The transport is up. **A real gate**: safe to command. |
| `capability_discovery` | The driver is querying the device's real capability set (e.g. Yamaha's `getFeatures`, CoolMaster's `discoverAll`). |
| `state_sync` | The driver is reading back the device's current state (e.g. KNX `syncAll()`'s `bus.group_read`). |
| `ready` | Capability discovery + state sync are done — the device is fully known. |
| `operational` | Steady state — commands flow, state updates arrive. |
| `reconnecting` | The link dropped and a reconnect is in progress (AVR/HEOS `ReconnectScheduler`, CoolMaster's connection manager, etc). |
| `disconnected` | The link is down and not currently retrying. |
| `unbinding` | `unbind()` is running — cleanups are being drained. |
| `unbound` | All registered cleanups have run for this device. |
| `destroyed` | **Terminal.** Any further use of this controller/binding is a programming error, not a warning. |

### Which states are gates vs. observational

Only a handful of these states are actually **enforced**: `bound` (a binding exists),
`connected`/`ready` (safe to command — several drivers, e.g. `avr-driver.ts` and
`heos-driver.ts`, explicitly check `link.ready` before writing), `unbinding`/`unbound`
(cleanup in progress/complete), and `destroyed` (terminal). The states in between
(`discovering`/`discovered`/`capability_discovery`/`state_sync`/`operational`/
`reconnecting`/`disconnected`) are real and drivers pass through them, but they're
**observational, not mandatory checkpoints** — no driver author needs to call
`transition()` for every single one if their protocol's shape doesn't distinguish them.
HEOS has no capability-discovery step at all (there's nothing to discover — the wire
protocol tells you everything at `get_players` time); that's fine. Skipping a state is
never an error. Only moving **backward** through the forward sequence, or transitioning
**out of `destroyed`**, is.

### Deterministic transition rules

`DriverLifecycleController.transition()`:

- **Idempotent**: transitioning to the *current* state is always a safe no-op — calling
  `unbind()` twice both times attempts `transition("unbinding")`, and the second call
  is a no-op, not an error. This is what makes "repeated calls must be safe" true.
- **Forward-only through the linear sequence** (`created` → … → `operational`) — going
  backward (e.g. `ready` → `binding`) throws `InvalidLifecycleTransitionError`.
- **Recoverable exceptions**: `reconnecting`, `disconnected`, and `connecting` may be
  entered from almost anywhere in the forward sequence — that's real network life, not
  a violation.
- **`destroyed` is a hard wall**: any transition attempted after `destroyed` throws.

## `DriverLifecycleController` — the resource-cleanup registry

The other half of the primitive, alongside state tracking:

```ts
const lc = new DriverLifecycleController();

// As the driver acquires a resource for this device, register how to release it:
const timer = setInterval(poll, 5000);
lc.registerCleanup(() => clearInterval(timer));

const unsubscribe = bus.observe(groupAddress, dpt, handler);
lc.registerCleanup(unsubscribe);

// unbind() drains everything, LIFO, tolerating individual failures:
const { ok, errors } = await lc.runCleanups();
```

- **LIFO order** — cleanups run in reverse-registration order, mirroring a stack
  unwind, so a later resource that depends on an earlier one is released first.
- **Fault-tolerant** — one cleanup throwing doesn't stop the rest; every error is
  collected and returned, never thrown mid-unwind. A failing socket close must not
  prevent a timer from also being cleared.
- **Idempotent** — a second `runCleanups()` call runs against an empty registry and
  does nothing (transitions are no-ops from `destroyed`).
- **Early release** — `registerCleanup()` returns an unregister function for the rare
  case a driver wants to release one resource before the whole device unbinds, without
  running it twice.

In practice, **most of the 22 fleet drivers do not use `DriverLifecycleController`
directly** — see [Resource-Cleanup.md](./Resource-Cleanup.md) for why: their resources
are simple enough (a shared timer, a bookkeeping array) that direct removal from
`bindings`/`devices`/`states` in `unbind()` is clearer than routing through a registry.
`DriverLifecycleController` is the SDK primitive for drivers whose per-device resource
graph is complex enough to benefit from it (or for a future driver author who wants the
LIFO/fault-tolerant guarantees for free) — it is offered, not imposed. See
`services/integration-layer/src/protocols/lifecycle.test.ts` for the full contract
under test (11 cases: forward sequence, backward rejection, idempotent same-state
transition, recoverable reconnect path, terminal-destroyed rejection, LIFO order,
tolerates one cleanup throwing, async cleanups, idempotent `runCleanups()`, early
release, "no resources remain" guarantee).

## How `unbind()` reaches a driver: the call chain

Deleting a device is the trigger. The path from an HTTP `DELETE` to a driver's
`unbind()`:

```
DELETE /v1/devices/:id
  → HomeService.removeDevice(deviceId)
    → SupremeIntegrationLayer.unmapDevice(deviceId)
      → IBackendAdapter.unbindDevice?.(deviceId)     ← new seam (adapter.ts)
        → RoutingBackendAdapter.unbindDevice(deviceId)
          → SupremeNativeAdapter.unbindDevice(deviceId)
            → the OWNING driver's unbind(deviceId)   ← the actual per-device release
          → HA adapter's unbindDevice?.(deviceId)     (best-effort, same call, HA side)
      → registry.unmapDevice(deviceId)                (SIL bookkeeping)
      → ownership.clear(deviceId)                     (ownership bookkeeping)
```

`RoutingBackendAdapter.unbindDevice()` runs **both** the native and HA paths
unconditionally — deliberate over-cleaning as the safe failure mode; calling an
`unbind()` a device was never bound to is defined to be a no-op (see
[Driver-SDK.md](./Driver-SDK.md)).

End-to-end proof: `services/gateway/src/driver-lifecycle-unbind.e2e.test.ts` drives this
entire chain through the real HTTP API (`POST /v1/commissioning/discover` →
`POST /v1/commissioning/commission` → `DELETE /v1/devices/:id`) against a fake driver
holding a real per-device `setInterval` timer, and asserts the timer is gone after
delete — not just that a callback fired.

## Rebind — Unbind → Bind → Reconnect → Continue

A device can be unbound and rebound to the **same, still-running driver instance**
without recreating the driver object — this matters for reconfiguration flows (e.g.
re-pointing a binding at a different group address) that shouldn't pay the cost of a
full driver teardown/reboot. Proven in
`services/integration-layer/src/native-adapter.test.ts` ("supports Rebind... without
recreating the driver object") and, for a driver with a genuine per-host resource cache,
in `yamaha-driver.test.ts`'s unbind block: unbinding the last device on a host clears
its feature cache and refresh timer, and rebinding the same host on the **same driver
instance** triggers a fresh `getFeatures` fetch — proof the teardown was real, not a
no-op, and that the driver object itself was never thrown away.

## See also

- [Driver-SDK.md](./Driver-SDK.md) — the `INativeProtocolDriver` interface, what
  `unbind()` must do, and the shared cleanup helpers.
- [Resource-Cleanup.md](./Resource-Cleanup.md) — the resource taxonomy, the three
  patterns used across the fleet, and the audit findings.
- [Driver-Author-Guide.md](./Driver-Author-Guide.md) — how to write a new driver with
  `unbind()` correct from day one.
