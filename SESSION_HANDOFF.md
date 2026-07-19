# SESSION_HANDOFF.md

> Current development state. **Rewrite this at the end of every session** — it should describe
> what changed *since the previous handoff*, not the whole project history (that's
> `PROJECT_CONTEXT.md`). Keep it concise.

**Branch:** `claude/supremeos-universal-av-sdk-0rtaiw`, based on `main` at session start. This
turn: **SupremeOS Driver Lifecycle Completion** — closing the fleet-wide missing-`unbind()` gap
the previous turn's AVR production audit found (explicitly scoped platform-wide, not
AVR-specific, per the user's own framing).

## Current development status

Every one of the 22 native protocol drivers in `@supreme/protocols` now implements
`unbind(deviceId): Promise<void>` — releasing exactly what that one device holds without
disturbing any other device the same driver still manages, verified idempotent, and reached
end-to-end from `DELETE /v1/devices/:id`. **None had it before this turn**, including the 3
flagship AVR-family drivers (AVR/HEOS/Yamaha) — the prior handoff's summary of "already done" for
those three was wrong; corrected here by actually reading the files rather than trusting the
summary.

**Full documentation:** `docs/architecture/Driver-Lifecycle.md` (the 20-state lifecycle + the two
distinct lifecycle scopes), `Driver-SDK.md` (the `INativeProtocolDriver` contract + shared
helpers), `Resource-Cleanup.md` (resource taxonomy, the 4 fleet-wide patterns, the full audit
table, every bug found and fixed), `Driver-Author-Guide.md` (checklist for writing a new driver
correctly from day one).

## Completed this session

1. **New Driver SDK primitive**: `DriverLifecycleController`
   (`services/integration-layer/src/protocols/lifecycle.ts`) — the 20-state
   Created→...→Destroyed lifecycle (deterministic, idempotent same-state transitions, rejects
   backward/post-destroyed transitions) plus a LIFO, fault-tolerant resource-cleanup registry.
   Composition-based (not a base class — this fleet has no shared driver base class and
   introducing one now would mean rewriting 22 working drivers, which was explicitly out of
   scope). 11 tests, all passing. Exported from `@supreme/integration-layer`.
2. **The actual wiring fix (the root cause)**: `SupremeIntegrationLayer.unmapDevice()` previously
   only cleared SIL-level bookkeeping (`registry`/`ownership`) and never told the owning driver to
   release its own resources. Fixed by adding `unbindDevice?(deviceId)` to `IBackendAdapter`,
   implementing it on `SupremeNativeAdapter` (calls the owning driver's `unbind()`, then forgets
   the device) and `RoutingBackendAdapter` (runs both native + HA paths unconditionally — safe
   over-cleaning), and calling it first thing in `unmapDevice()`.
3. **`unbind()` implemented on all 22 fleet drivers**, categorized into 4 resource patterns (see
   `Resource-Cleanup.md` for the full table and code shape of each):
   - **Pattern 1 (simple bookkeeping-only)**: WiiM, DALI, Devialet, Shelly, Modbus, Lutron, SIP,
     Zigbee, Ajax, Casambi, CoolMaster (11 drivers) — via new shared helpers
     `removeDeviceBindings`/`removeDeviceStates` (`services/protocols/src/binding-cleanup.ts`).
   - **Pattern 2 (per-device transport close)**: AirPlay, Apple TV, Sonos — also fixed a REAL
     pre-existing bug: their `disconnect()` never cleared `bindings`/`devices`/`states` at all and
     had no way to close per-device sender/client/player objects (no `close()` on the interface).
   - **Pattern 3 (shared subscription key)**: MQTT (topic-keyed), KNX `knx-driver.ts` and Matter
     (both had a real leak — `subscribe()`/`observe()` returned `void` with no unsubscribe
     mechanism at all; fixed by changing both to return an unsubscribe function), and
     `knx/supreme-knx-driver.ts` (the parallel/future KNX implementation — also fixed its
     GA-scoped `unsubscribe()` risk of killing a sibling device's subscription, and added
     `OfflineCommandQueue.evict()` so a device's queued offline commands don't outlive it).
   - **Pattern 4 (shared host link)**: AVR, HEOS, Yamaha — release the shared TCP link / cached
     host features only once the last device on that host is unbound.
   - **Tuya variant**: per-device-address transport client, closed once no bound capability (of
     any device) still references that address.
4. **A 5th real bug found while writing regression tests**: `SupremeNativeAdapter.connect()` was
   not idempotent — a repeated call re-subscribed a NEW `onState` listener on every driver every
   time, without ever removing the previous one. A written 20-call reconnect-storm test caught it
   immediately (21 duplicate events instead of 1). Fixed with a one-line `if (this.connected)
   return;` guard; verified safe against every real call site and the full gateway (222 tests) +
   integration-layer (47 tests) suites before and after.
5. **Regression tests** covering: per-driver unbind (every driver above has at least a
   basic-unbind + idempotency test; AVR/HEOS/Yamaha/MQTT/KNX/SupremeKnxDriver additionally have
   shared-resource-isolation tests proving a sibling device's link/subscription survives), repeated
   bind→unbind cycles (50 iterations, no accumulation), Rebind (unbind→bind on the SAME driver
   instance, never recreated), reconnect storms (20 rapid `connect()` calls, no duplicate events),
   and an end-to-end HTTP-API proof (`services/gateway/src/driver-lifecycle-unbind.e2e.test.ts` —
   discover → commission → `DELETE /v1/devices/:id` → assert the driver's real per-device timer is
   gone, not just that a callback fired).
6. **Four new architecture docs** — see `docs/architecture/Driver-Lifecycle.md`, `Driver-SDK.md`,
   `Resource-Cleanup.md`, `Driver-Author-Guide.md`.

## Final report

- **Drivers audited:** 22 of 22 in `@supreme/protocols` (every driver implementing
  `INativeProtocolDriver`), plus the parallel/future `knx/supreme-knx-driver.ts` implementation.
- **Drivers fixed (given a real `unbind()` where none existed):** 22 of 22 — 100%.
- **Additional real leaks found and fixed beyond "missing `unbind()`":** 5 — (1) AirPlay/Apple
  TV/Sonos `disconnect()` never cleaning up at all; (2) Matter's `subscribe()` had no unsubscribe
  mechanism; (3) KNX's `observe()` (native `knx-driver.ts`) had the same gap; (4)
  `SupremeKnxDriver`'s offline command queue had no per-device eviction; (5)
  `SupremeNativeAdapter.connect()` was not idempotent, duplicating state events under repeated
  connect calls.
- **Lifecycle compliance:** **100%** — every driver in the fleet now implements `unbind()`
  correctly (idempotent, scoped to one device, shared resources released only once the last
  reference is gone), verified by driver-specific regression tests plus fleet-wide
  bind/unbind-cycle, rebind, and reconnect-storm tests, plus one full HTTP-API-to-driver e2e test.
- **Remaining known issues:**
  - `HeosProtocolDriver`'s `pendingQueue` (in-flight `get_queue` correlation-id map) is not
    evicted per-device on `unbind()` — it's bounded and self-clears via a 5-second timeout
    regardless, so it's not an unbounded leak, but it isn't instantaneous either. Noted, not
    fixed — genuinely low-risk given the bound.
  - No hardware verification of any driver's `unbind()` against real devices — all verification
    is against real embedded/in-process transports (aedes MQTT broker, in-process TCP/HTTP
    servers, injectable client fakes), consistent with the rest of this codebase's testing
    convention, but real hardware could theoretically surface a transport-specific edge case
    (e.g. a device that NAKs an unsubscribe request) that a fake can't.
  - `SupremeKnxDriver` (`knx/supreme-knx-driver.ts`) is a more elaborate parallel implementation
    of the KNX driver that is **not currently wired into production boot** (`bootstrap.ts`/
    `native-driver-factory.ts` both instantiate `KnxProtocolDriver` from `knx-driver.ts`, not
    `SupremeKnxDriver`) — it's fixed and tested for completeness/consistency, but flagging this
    so a future session doesn't assume it's the live KNX path.

## Files touched this session

- New: `services/integration-layer/src/protocols/lifecycle.ts` (+ `.test.ts`)
- New: `services/protocols/src/binding-cleanup.ts` (+ `.test.ts`)
- New: `services/gateway/src/driver-lifecycle-unbind.e2e.test.ts`
- New: `docs/architecture/{Driver-Lifecycle,Driver-SDK,Resource-Cleanup,Driver-Author-Guide}.md`
- Modified (interface/wiring): `services/integration-layer/src/{adapter,index,native-adapter,
  routing-adapter,sil}.ts` and their `.test.ts` files; `services/integration-layer/src/protocols/
  driver.ts` (added optional `unbind?()`); `services/gateway/src/installer-context.ts` (added
  `"stopping"` stage, unrelated orchestration-lifecycle observability improvement)
- Modified (unbind() added, all with test coverage): `services/protocols/src/{avr,heos,yamaha,
  wiim,airplay,apple-tv,dali,devialet,sonos,shelly,modbus,mqtt,lutron,sip,zigbee,ajax,casambi,
  coolmaster,tuya,matter,knx}-driver.ts`, `services/protocols/src/knx/supreme-knx-driver.ts`,
  `services/protocols/src/knx/offline-command-queue.ts` (+ new `evict()` method)
- Modified (interface fix — `subscribe`/`observe` now return an unsubscribe fn):
  `services/protocols/src/matter-driver.ts` + its `.test.ts` and `matter-fabric.test.ts`;
  `services/protocols/src/knx-driver.ts` + its `.test.ts`

## Architecture decisions made this session

- **`DriverLifecycleController` is composition-based, offered not imposed** — most drivers
  (pattern 1/2) implement `unbind()` via direct `Map`/`Set`/array manipulation because it's
  simpler than routing through the controller for 2-3 items with no real ordering dependency.
  The controller exists for drivers whose resource graph genuinely benefits from LIFO +
  fault-tolerant release.
- **`unbind` stays optional (`?`) at the type level** — matches every prior optional addition to
  `INativeProtocolDriver` (`getArtwork`/`getQueue`/`getCapabilityConfig`/`getDiagnostics`).
  Functionally mandatory in practice (100% of the current fleet implements it); kept optional so
  a future driver that skips it degrades gracefully via `unbind?.()` rather than failing to
  compile, with the regression-test suite (not the type system) as the actual compliance gate
  going forward.
- **`RoutingBackendAdapter.unbindDevice()` runs both native + HA paths unconditionally** —
  deliberate over-cleaning as the safe failure mode, since determining a device's true owner
  ahead of the call isn't always cheap, and calling `unbind` on the wrong side is defined to be a
  no-op.
- **Fixed `subscribe()`/`observe()` return signatures (Matter, KNX) rather than working around the
  gap** — a per-binding subscription with genuinely no way to unsubscribe is not something
  `unbind()` can honestly fix from the outside; the transport interface itself had to change to
  return an unsubscribe function. Both affected test fakes were updated to match.

## Immediate priorities for the next session

1. Nothing blocking remains for the Driver Lifecycle Completion effort itself — it's done.
2. If revisiting HEOS: consider evicting `pendingQueue` entries for an unbound device's `pid` on
   `unbind()`, even though the current 5s TTL bound makes this low-priority.
3. Everything from the prior handoff not touched this session remains open: no hardware
   verification of any driver (AVR framework or otherwise), the small named AV gaps (Yamaha EQ,
   HEOS QuickSelect UI, HEOS Bluetooth modeling), wiring more protocols into the generic Room
   Assignment Engine, the whole-home Media Dashboard topology graph view, Bluetooth pairing
   management, local voice fulfillment, Infrastructure module device types #2-8, design-polish
   phase, and the density-breakpoint remount bug.

See `TODO.md` for the full backlog with priority tiers.
