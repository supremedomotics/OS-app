# ADR 0011 — Matter commissioning + fabric seams (controller behind a hardware boundary)

- Status: **Accepted**
- Date: 2026-06-28
- Context: blueprint §9 (Matter, opt-in/user-activatable), ADR 0001 (SIL), ADR 0010 (ecosystem).

## Context

Matter is a first-party, opt-in protocol that "ships disabled and is enabled on demand, running
entirely on the hub" (blueprint §9). The capability codec (clusters ↔ Supreme capabilities) and the
driver already existed, but two things were missing for a real certification track: a way to
**commission** (pair) a new device from its setup code, and **fabric/credential coordination** so a
home's fabric can be multi-admin (shared with Apple Home / Google).

The hard constraint: a production Matter controller (`@matter/main` CHIP stack, PASE/CASE, Thread
radios) requires real hardware/radios that cannot run or be verified in CI. We must make real,
tested progress without pretending the hardware controller exists.

## Decision

Build everything up to — but not including — the hardware controller, behind the existing injected
`MatterController` seam:

- **Setup-code parsing** (`services/protocols/matter-pairing.ts`): spec-accurate decode of the
  11/21-digit **manual pairing code** (Verhoeff-checked) and the `MT:` **QR payload** (base-38 +
  packed bit fields → discriminator, passcode, VID/PID). Pure and dependency-free; validated against
  the canonical chip-tool vector (discriminator 3840, passcode 20202021). This is exactly what the
  commissioning UI uses to validate a code before pairing.
- **Commissioning seam**: `MatterController` gains `commission(payload)`; `MatterProtocolDriver`
  gains `commission(setupCode)` which parses the code, onboards the node, emits an `onCommissioned`
  event, and returns a Supreme `DiscoveredDevice`. Tests drive it through a fake fabric.
- **Fabric manager + cloud sync** (`matter-fabric.ts`, `cloud/matter`): a hub-side
  `MatterFabricManager` ensures the home's fabric and mirrors each commissioned node to the OPTIONAL
  cloud Matter service (`buildMatterServer`, per-hub API key → homeId, idempotent
  `ensureFabric`, multi-admin co-admins). Sync is **best-effort and non-fatal** — Matter keeps
  working on the hub if the cloud is unreachable.
- **Gateway routes**: `GET /v1/matter/status` (enabled / connected / fabric / node count) and
  `POST /v1/matter/commission` (installer-gated; parses the code, pairs, registers the node as a
  Supreme device, binds the Matter protocol). The driver is exposed to the route via an optional
  `MatterHandle` on the context — bootstrap puts the **same** driver instance in the SIL's native
  adapter and the handle, so binding routes commands for real.

## Consequences

- The only piece that is **not** runnable here is `defaultMatterController` (the CHIP/Thread stack);
  it throws an actionable error until a hardware-initialized controller is injected via
  `createController`. Everything above it — code parsing, commissioning flow, device registration +
  binding, fabric/multi-admin metadata, cloud sync — is implemented and unit/e2e-tested (the e2e
  pairs a device end-to-end with only the controller faked).
- The opt-in stays env/compose-gated (`SUPREME_MATTER_ENABLED`); status now surfaces the enabled +
  connected state to clients so the app can drive the "enable Matter" UX.
- Next, gated on hardware bring-up: wire `@matter/main` into `createController` (PASE/CASE + NOC
  issuance), Thread Border Router, and Matter-bridge export of non-Matter devices.
