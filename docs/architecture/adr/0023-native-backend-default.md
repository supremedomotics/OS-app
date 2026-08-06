# ADR 0023 — Supreme-native engine is the default backend; Home Assistant is optional

- Status: **Accepted**
- Date: 2026-08-06
- Context: production hardening milestone following a Home Assistant Dependency
  Audit — replace the production use of `MockAdapter` with the already-existing
  Native Backend (`SupremeNativeAdapter`) as the default, and make Home Assistant a
  genuinely optional compatibility plugin rather than an implicit boot dependency.

## Context

`RoutingBackendAdapter` (`services/integration-layer/src/routing-adapter.ts`) has, for
some time, unconditionally wired `SupremeNativeAdapter` as its `native` slot — every
native-protocol device already routed there regardless of `SUPREME_BACKEND`. The
`ha` slot, however, was always either a real `HaAdapter` (`SUPREME_BACKEND=ha`) or
`MockAdapter` (every other value, including unset) — `GatewayConfig.backend`'s type
was `"mock" | "ha"` with no third option. A hub that never set `SUPREME_BACKEND`
therefore always had a fabricated, in-memory `MockAdapter` occupying a slot meant to
represent a real backend. Compounding this, `HomeService.bind()` defaulted every
newly-mapped device's ownership to `"ha"` unconditionally — the exact "nothing else
claimed it so it must be HA" heuristic `OwnershipRegistry`'s own docstring forbids.

## Decision

- `SUPREME_BACKEND` gains a third value, `"native"`, and it becomes the default
  (`services/gateway/src/config.ts`). `"mock"` remains a valid, explicit opt-in for
  tests/dev only; `assertSecureConfig()` now refuses to boot in production with
  `SUPREME_BACKEND=mock`.
- A new class, `HaUnavailableAdapter` (`services/integration-layer/src/
  ha-unavailable-adapter.ts`), replaces `MockAdapter` as the router's `ha` slot
  whenever `SUPREME_BACKEND !== "ha"`. It implements `IBackendAdapter` honestly: no
  connection, no discovered devices, every command/read refused with a clear
  `backend_unavailable` error — never a silent, fabricated success.
- `HomeService.bind()`'s default ownership is now conditional on whether the hub's
  configured HA-compatibility slot has a genuinely working backend behind it (a real
  `HaAdapter`, or `MockAdapter` standing in for one in tests) — `"ha"` only then,
  `"native"` otherwise (the production default).
- `SupremeIntegrationLayer.primeState()` (new) centralizes "seed an in-process
  engine's per-device state cache from persisted truth on boot" — previously only done
  for `MockAdapter`, now done uniformly for whichever engine (native or mock) actually
  owns an unbound device, and run once from `AppContext.create()` so every boot path
  (the real hub and every test) gets it for free.
- `Device.status` is now genuinely reconciled from each device's owning native
  driver's real connectivity (`InstallerServices.reconcileDeviceStatuses()`), run on
  every driver lifecycle transition and once a minute from the gateway's tick loop.
  Devices with no honest connectivity signal (HA-owned, unassigned, or native but
  never bound) are left untouched — no guess in either direction.
- `AutomationService.create()`/`update()` now reject `engine: "ha"` outright
  (`services/automations/src/service.ts`) rather than silently accepting a row that
  `AutomationEngine.setAutomations()` was already filtering out of execution. A
  legacy, already-persisted `engine: "ha"` row now reports `health() === "broken"`
  with a clear reason instead of looking idle-but-fine.

No existing class was duplicated or forked: `SupremeNativeAdapter` already was, and
remains, the Native Backend Adapter this milestone's brief asked for — see
`docs/architecture/Native-Backend-Implementation.md` §0 for the full account of why
the brief's stated "current architecture" didn't match the code, and what the actual
gaps turned out to be.

## Consequences

- Zero protocol driver, deployment file, or UI component was modified. Every change
  is confined to `services/integration-layer`, `services/home`, `services/gateway`
  (config/bootstrap/context/installer-context/main), `services/automations`, and
  `packages/domain-model`'s automation DSL doc comment.
- A hub with `SUPREME_BACKEND` unset (the common case, including every existing
  deployment that never explicitly set it) now defaults to the Native Backend instead
  of an implicit mock — this is the intended fix, but it is a real behavior change for
  any existing deployment that was unknowingly relying on `MockAdapter`'s permissive
  in-memory behavior for devices it never explicitly imported from Home Assistant.
  Operators who genuinely need Home Assistant must now set `SUPREME_BACKEND=ha`
  explicitly (this was already required for HA to function correctly; it is now also
  required for it to be reachable at all in the router's `ha` slot).
- `engine: "ha"` automation execution remains a known, disclosed gap: rejecting new
  ones (chosen over building a live push-to-HA lifecycle, which was out of this
  milestone's scope and unverifiable without a live HA instance in this sandbox) means
  any future request to genuinely support HA-executed automations is still open work,
  not silently declared "done" by this ADR.
- `HaAdapter` still doesn't implement the richer optional `IBackendAdapter` members
  (artwork, queue, capability config, diagnostics, trace, keypad) — pre-existing,
  unaffected, and each is individually a reasonable "no generic HA entity concept for
  this" rather than an oversight, but is worth another audit pass if HA compatibility
  is ever asked to reach feature parity with the native engine.
