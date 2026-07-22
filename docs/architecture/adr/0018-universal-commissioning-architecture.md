# 0018 — Universal Commissioning Architecture

## Status

Accepted.

## Context

By this point in SupremeOS's evolution, four onboarding flows existed: auto-commission
(`scanForApproval`'s ordinary-device fast path), Pending Approval (`approvePendingDevice`),
manual pairing (`commissionDevice`, called directly from `discover.tsx`), and KNX's two flows
(`approveKnxDevice` for live discovery, `commissionImported` for ETS import). An audit for this
ADR found that **all five already called the same core** — `CommissioningService.commission()` —
which does the actual Device Registry write (id assignment, room, capabilities, `supremeType`
inference). There was no second Device Registry writer hiding anywhere.

The real duplication was one layer up: three separate implementations of "resolve a room, call
`commission()`, then loop over capabilities binding each to a bus address" —
`commissionDevice()`, `commissionImported()`, and `approveKnxDevice()` each wrote this glue
independently, because only `commissionDevice()`'s binding loop existed, and it only supported
binding every capability to the SAME address — which is wrong for a real KNX device where onoff
and brightness genuinely live at different group addresses. `commissionImported()` and
`approveKnxDevice()` couldn't reuse it, so they didn't.

## Decision

**One room-resolution-and-registry-write call, for every onboarding flow.**

```
Casambi Discovery ─┐
KNX Live Discovery ─┤
KNX ETS Import ─────┼──▶ commissionDevice()  ──▶  resolveOrCreateRoom()
Manual Pairing ─────┤         │                          │
Pending Approval ───┘         └──▶ CommissioningService.commission()  (Device Registry write)
                               │
                               └──▶ per-capability bindProtocol() loop
```

`commissionDevice()` (`installer-context.ts`) gained an optional `bindings` parameter — a
per-capability `{capability, address, config}[]` — alongside its existing single-address
`protocol`/`address`/`config` trio. A caller with one shared bus address (Casambi, manual
pairing, most auto-commit devices) uses the simple trio unchanged; a caller whose capabilities
live at genuinely different addresses (KNX) passes `bindings` instead. Both paths funnel through
the SAME room-resolution call and the SAME `commission()` call — only the binding loop's shape
differs, because that's a real difference in what "one device" means on the wire for that
protocol, not an architectural split.

`commissionImported()` (KNX ETS import) now calls `commissionDevice({..., bindings})` instead of
reimplementing resolve-room + commission + bind itself — collapsing one of the three duplicated
glue blocks entirely.

`approveKnxDevice()` (KNX live-discovery approval) calls `commissionDevice({...})` for the
room-resolve + registry-write step, then keeps its OWN per-capability bind loop with
rollback-on-failure. This is a **deliberate, disclosed exception**, not leftover duplication: a
partially-bound device rolling itself back on a mid-binding failure is a genuine KNX-approval
safety behavior (a live bus write failing partway through must not leave a half-registered
device), and imposing that same rollback semantic on every OTHER protocol's commissioning call
(Casambi, Matter, future drivers) was never asked for and isn't obviously correct for all of
them. If a future protocol needs the same guarantee, it composes the same way: call
`commissionDevice()` without `bindings` for the registry write, then bind + roll back itself —
never a second registry-write implementation.

## Responsibilities

- **Drivers** discover devices in their own native way (Casambi's BLE gateway, KNX's KNXnet/IP,
  a future Matter/Zigbee/DALI driver's own transport) and normalize capabilities +
  `capabilityConfig` (§ ADR 0017) at discovery time. They never write to the Device Registry.
- **Capability Normalization** (§ ADR 0017) turns protocol-specific signals into the generic
  `DeviceCapability.config` shape. It runs entirely inside each driver's codec, before
  commissioning is ever called.
- **Commissioning** (`CommissioningService.commission()` + `installer-context.commissionDevice()`)
  is the ONLY code that resolves a room and writes a new `Device` into the registry. It knows
  nothing about KNX, Casambi, Matter, Zigbee, DALI, BACnet, or Modbus — it consumes
  `{backendId, name, capabilities, capabilityConfig?, roomId?, roomNameHint?, protocol?,
  bindings?}` and nothing more specific than that.
- **Device Registry** (`HomeService`/persistence) is the single store every commissioning path
  writes into — unchanged by this ADR, already unified.
- **The UI** (`getDeviceUiCapabilities()`, § ADR 0016) reads only the persisted, normalized
  device — it has no idea which onboarding flow produced it.

## Future driver integration

Adding protocol N in ten years means: (1) a driver that discovers devices and normalizes their
capabilities/`capabilityConfig` per ADR 0017, (2) a call into `commissionDevice()` — with a
simple single-address `protocol`/`address` for the common case, or `bindings` if capabilities
need distinct addresses. Nothing else. No new commissioning engine, no new Device Registry
writer, no protocol branch inside commissioning itself.

## Consequences

- `commissionImported()`'s duplicated resolve-room + commission + bind block is gone — it now
  calls the same `commissionDevice()` every other flow uses.
- `approveKnxDevice()` converges on `commissionDevice()` for room-resolve + registry-write; its
  bind-with-rollback loop remains local by deliberate design (see above), not because it
  couldn't be moved.
- Zero behavior change for any existing flow: full gateway regression (242/242, including all 8
  KNX installer-workflow/ETS-import/approval tests) passes unchanged.

## Remaining architectural splits (disclosed, not silent)

- `approveKnxDevice()`'s bind-with-rollback loop is intentionally NOT folded into
  `commissionDevice()` — see "Decision" above for why forcing that semantic onto every caller
  would be a behavior change nobody asked for, not a genuine unification.
- No driver exists yet for Matter, Zigbee, DALI, BACnet, or Modbus in this codebase — this ADR's
  guarantee is proven for Casambi and KNX (the two real drivers) plus synthetic tests shaped like
  the others; it is a design contract for future drivers, not something exercised against real
  Matter/Zigbee/DALI hardware.
