# Claude Code Task: Build SupremeOS's Independent KNX Driver

Work in this repository on branch `feat/knx-clean-room-driver-foundation`.

Read before changing code:
- `docs/architecture/supreme-knx-clean-room-driver-blueprint.md`
- `docs/architecture/knx-driver-handoff.md`
- `services/protocols/src/knx-driver.ts`
- `services/protocols/src/knx-codec.ts`
- `services/protocols/src/knx/provider.ts`
- `services/protocols/src/knx/supreme-knx-driver.ts`
- `services/protocols/src/knx/knx-ultimate-provider.ts`
- existing tests in `services/protocols/src/knx*.test.ts` and `services/protocols/src/knx/`

## Mission
Independently implement a clean-room KNXnet/IP transport and migrate SupremeOS away from `knxultimate`, while preserving all validated current functionality and adding individual-address device diagnostics, functional feedback diagnostics, and safe auditable self-healing.

## Hard constraints
- Do not use `knxultimate` in new code or rely on it as a fallback in the shipping artifact.
- Do not copy its source, comments, code, tests, or implementation-specific design. Work from published KNX specifications and independently authored protocol tests/fixtures. Maintain a provenance note for each source used.
- Do not delete dependencies or modify production bootstrap to switch the live driver in the first commit.
- Do not claim to ping an individual KNX device with ICMP or infer it is dead from a group address timeout.
- Never mark a state observed just because a write was sent.
- Never blindly replay stale commands after reconnect, especially locks, blinds, security, HVAC and other potentially hazardous operations.
- Never send arbitrary, discovery-generated or "test" control writes to customer GAs.
- Keep KNX IoT Point API on its own CoAP transport; do not use it to replace KNXnet/IP group comms.
- Preserve existing public APIs, data shapes and import/binding semantics unless a documented migration requires a versioned change.
- No production release claim before parity tests and hardware-in-the-loop validation.

## Stage 0 — inventory and guardrail tests (first deliverable)
1. Search the entire monorepo for `knxultimate`, including dynamic imports, package manifests, lockfile, tests, build scripts and Docker/bundle configuration.
2. Trace production creation from `services/gateway/src/bootstrap.ts` to `KnxProtocolDriver`; separately map `SupremeKnxDriver` and all provider task routing.
3. Build a machine-readable test inventory for current functionality and list exact missing/unsupported DPTs, security modes, routing/tunnelling modes and diagnostics.
4. Add/extend fake transport contract tests for write/read/response, ACK/sequence validation at the new transport boundary, indication type filtering, multiple observers, unbind and disconnect cleanup, reconnect state sync, queue policies and import compatibility.
5. Submit findings and a proposed task breakdown before implementing wire-level tunnelling.
6. Keep all existing tests passing. Do not silently update snapshots to conceal changed behaviour.

## Stage 1 — transport boundary and frame codec
Implement under `services/protocols/src/knx/native/` (or another focused folder explained in the PR):
- socket abstraction with injectable fake;
- KNXnet/IP header parse/encode, strict length and service-type validation;
- HPAI/DIB parsing and gateway discovery test cases;
- cEMI and APCI parse/encode with distinct group read, response and write;
- canonical individual/group address encoders/validators;
- explicit typed error taxonomy and bounded counters.

Do not implement a fake "complete KNX stack" in one file. Keep framing, tunnelling state, group communication, DPT codecs and driver adaptation separate.

## Stage 2 — tunnelling lifecycle
Implement protocol-correct connect request/response, negotiated data endpoint, channel identity, sequence handling, ACK/retransmission, connection-state heartbeat, disconnect, deadline, reconnect coordination, listener disposal and socket cleanup per normative KNXnet/IP specification. Add deterministic tests for loss, duplication, out-of-order, late ACK, channel close, timeout and cancellation.

If routing mode is also targeted, implement it as a distinct transport with explicit NIC/multicast selection, not as a silent fallback from a failed tunnel. Document limitations and require bus simulator / real gateway validation. KNX Secure / Data Secure are separate gated phases unless complete normative implementation, ETS keyring handling and test assets are available.

## Stage 3 — DPT parity
Preserve `knx-codec.ts` as the capability-level mapper. Implement independent DPT wire codec coverage from published DPT specifications and authored golden vectors. Test every DPT used by the installed config/test fixtures, including invalid/reserved values, scale, endianness, float encoding, RGB/CCT/RGBW and multi-field HVAC values. Unsupported DPTs must raise typed errors, not silently fallback to a different DPT.

## Stage 4 — switch transport via feature flag
Adapt the existing `KnxConnection` / `IKnxProvider` contracts to the new transport without breaking caller signatures. Keep `KnxProtocolDriver` as the production-facing driver unless migration findings require otherwise. Migrate commissioning-time tasks separately. Keep one active command writer per gateway. Feature flag defaults to legacy only during the temporary migration period; the final artifact must remove the legacy route rather than keeping a hidden dependency forever.

## Stage 5 — health and safe self-healing
Add separate APIs/results for:
1. gateway/session health,
2. KNX individual-address existence diagnostics (supported hardware/topology permitting),
3. group-address functional read/feedback health.

Every status must identify evidence, timeouts and reasons. Include reachable/unreachable/indeterminate/conflicting outcomes. A group response timeout is not enough to diagnose a device failure. When a telegram reports a state, record source, type, GA, DPT, correlation id and timestamp where known.

Self-healing levels:
- detect and explain;
- bounded retry of safe idempotent transport operations;
- reconnect tunnel and restore subscriptions;
- resync declared readable state GAs at a controlled rate;
- recommend mapping repair for installer approval;
- control telegram recovery only where a safety policy explicitly permits it.

Do not auto-reprogram or reset devices, alter individual addresses, bypass security, or blindly replay stale queue entries. Keep recovery audit records bounded and privacy-aware.

## Stage 6 — verification and dependency removal
- Run tests and build/typecheck with documented commands.
- Add fuzz/property tests for malformed packets, bounds and unexpected APDUs.
- Run the project's full test suite.
- Search source, manifest, lockfile, generated dist, container image and SBOM for any `knxultimate` occurrence.
- Remove the dependency only after all required tests pass; regenerate pnpm lockfile with pnpm.
- Add a release gate checklist and a reversible feature flag/canary plan.

## Final report required
Report changed files, all commands/tests run and actual output, transport features implemented vs deferred, DPT coverage, security coverage, dependency scan evidence, health-check semantics, self-heal limits, and exact outstanding risks. Do not say tests passed if they were not run. Do not say physical devices are tested if they were only simulated.
