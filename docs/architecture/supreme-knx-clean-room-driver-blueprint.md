# SupremeOS KNX Driver — Clean-room Replacement Blueprint

Status: engineering specification; no production-driver cutover has been performed.
Branch: feat/knx-clean-room-driver-foundation

## Objective

Replace every runtime and build-time dependency on `knxultimate` with a Supreme-owned KNX implementation, preserving existing deployed functionality and the current SupremeOS driver contracts. Add trustworthy KNX diagnostics, fault isolation, supervised recovery, and auditable self-heal. Keep KNX IoT Point API as a separate, standards-based transport; do not treat it as a substitute for KNXnet/IP group communication.

This blueprint is a migration contract, not a claim that the driver is already implemented or production-ready.

## Verified current-state findings

Repository: https://github.com/supremedomotics/OS-app

- `services/protocols/src/knx-driver.ts` is the live `KnxProtocolDriver` registered by `services/gateway/src/bootstrap.ts`. Its default factory dynamically imports `knxultimate`.
- `services/protocols/src/knx/supreme-knx-driver.ts` is a separate commissioning/preview driver. It defaults to `KnxUltimateProvider` for group communication and `KnxIotProvider` for KNX IoT metadata/functional block discovery.
- `services/protocols/src/knx/knx-ultimate-provider.ts` imports the same dependency and includes connection supervision, diagnostics, group reads/writes and bus indication handling.
- `services/protocols/src/knx/knx-iot-transport.ts` speaks CoAP and must remain separate from KNXnet/IP. Existing ETS import and semantic discovery code is mostly transport-independent.
- `services/protocols/src/knx-codec.ts` already contains SupremeOS capability conversion logic. Preserve and regression-test this module instead of rewriting it as part of the transport work.
- `services/protocols/src/knx-discovery.ts` has hand-built KNXnet/IP gateway search framing. Treat this as existing code to audit and test, not evidence that tunnelling is already fully implemented.
- The public repository handoff document describes KNX Ultimate as MIT-licensed. MIT generally permits commercial use if its required notice conditions are met; therefore this is not a conclusion that using the package is inherently unlawful. The requested goal is a genuinely independent implementation, with legal review of license notices, provenance and any copied code before commercial release.

## Definition of "clean-room"

1. No import, runtime dynamic import, bundled package, copied source, copied comments, or transcribed implementation from KNX Ultimate in the replacement path.
2. Implement from protocol specifications and independently written tests. Record normative specification/version references for each wire-level feature.
3. Do not copy proprietary source or tests. A separate engineer can document externally observable behaviour and conformance cases; the implementation engineer works from the normative spec and those cases.
4. Run dependency and bundle scans (source, lockfile, build output, SBOM) proving `knxultimate` is absent from the market build.
5. Preserve third-party notices for remaining dependencies. Obtain legal review; this engineering plan is not a legal opinion or guarantee against copyright claims.

## Target architecture

```
SupremeOS Driver Lifecycle / ProtocolBinding / CapabilityCommand
                         |
                KnxProtocolDriver
                         |
     +-------------------+-------------------+
     |                   |                   |
State/command        Diagnostics          Recovery/
coordinator          & health engine       policy engine
     |                   |                   |
     +---------- KnxTransport seam ----------+
                         |
           Supreme KNXnet/IP implementation
       +-----------------+---------------------+
       |                 |                     |
   Tunnelling         Routing              (future gated)
   UDP session        multicast             KNX Secure
   control             cEMI                after spec,
       |                                     keyring and
   GroupValue read/write/response             conformance
       |
   independently maintained DPT codecs
       |
   KNX IP interface/router → KNX TP bus

Separate transport: KNX IoT Point API (CoAP discovery/resources/Observe)
It is never used to claim that classic KNX TP devices support IoT resources.
```

Keep the public `INativeProtocolDriver` contract, binding persistence shape, capability model, attribution rules for status feedback, HVAC multi-GA role handling, keypad input path, and the import/discovery outputs stable while the transport is replaced.

## Compatibility inventory — mandatory before parity claims

Create a machine-readable matrix for every existing test and reachable production function, at minimum:

- KNXnet/IP gateway discovery, adapter selection and clear failure diagnostics.
- Tunnelling lifecycle: connect, disconnect, state transitions, heartbeat/connection-state checks, sequence numbers, acknowledgements, timeout/retry, duplicate handling, graceful shutdown and bounded resource usage.
- Routing mode: multicast interface selection, frame parsing, de-duplication, origin/self-telegram handling, graceful degradation when multicast is blocked.
- GroupValue Write, Read, Response; distinguish APCI/telegram type and never decode a read request as state.
- Address encodings and validation: individual addresses, two-/three-level group addresses; canonicalization without changing persisted identity unexpectedly.
- DPT encoding/decoding parity for every DPT actually used by existing `knx-codec.ts`, ETS import and installed configurations. Unknown DPT must be explicit unsupported, never guessed.
- Status attribution: command transmission is not state confirmation; observe only declared feedback GAs unless installer explicitly marked shared GA feedback.
- Multi-observer fan-out, unsubscribe/unbind lifecycle, shared GA cleanup and duplicate-bind idempotence.
- State sync/read-after-reconnect, offline command queue TTL/merge behaviour, command deduplication policies and truthful provenance.
- ETS `.knxproj`, GA XML export and ESF import; room assignment, DPT classification, naming inference, duplicate prevention, review confidence and mapping overrides.
- HVAC auxiliary group-address roles, color/CCT, RGB/RGBW, blinds, sensors, locks and universal keypad events.
- KNX IoT Point API CoAP discovery/metadata/functional-block paths remain explicitly independent.
- Operational diagnostics, fault snapshots, installer-readable root-cause explanations, log redaction and bounded metrics.

Do not delete current code or remove the package dependency until every row has a test and the production canary passes.

## Health model — report three different truths

### 1. Gateway / transport reachability
Report gateway IP:port reachability, tunnel/session state, last successful heartbeat/connection-state response, retries, response latency, packet/ack counters, multicast receive diagnostics, and last error. A working IP interface does not prove the underlying TP bus is healthy.

### 2. Individual KNX device reachability
Where supported by the KNX interface and physical line, query the KNX individual address using protocol-correct diagnostics. Model results as:
- reachable: a valid, attributable reply was received inside the deadline;
- unreachable: a complete diagnostic ran but no valid reply arrived;
- indeterminate: diagnostics unsupported, filtered by coupler, blocked by security, line sleep/constraints, or test inconclusive;
- conflicting: duplicates or ambiguous responders.
Never label a device unreachable merely because an unrelated group address did not answer.

A KNX individual-address existence check is the appropriate analogue of a bus-level device ping. It is not ICMP ping. KNX address/line checks may have topology, coupler-filtering and device-response limitations; expose those caveats.

### 3. Functional feedback health
For each bound capability, report whether a status/feedback GA is declared, last real report time, last value, read-response latency and expected freshness. A GroupValueRead timeout means that group object did not return a usable value; it does not by itself prove the physical device is dead. Feedback can be disabled, filtered or unsupported.

### Suggested support-matrix fields

`homeId, gatewayId, physicalAddress, deviceName, room, deviceKind, observedGAs, statusGAs, dpt, lastSeenAt, lastDiagnosticAt, deviceReachability, feedbackHealth, transportHealth, confidence, faultCodes, recommendedAction`.

Only populate serial/manufacturer/product information where it was actually imported from ETS or obtained from a real response.

## Signature feature: Supreme KNX Health & Recovery

Installer-visible troubleshooting flow for "the light did not turn on":

1. Was the command accepted by SupremeOS? Record intent and correlation ID.
2. Was the group-write placed on the transport and acknowledged at the transport layer? Do not confuse transport acknowledgement with actuator execution.
3. Did a relevant bus telegram appear, and was it a write/response rather than a read request?
4. Did the configured feedback GA report the expected state before the configured deadline?
5. Is the physical KNX individual address reachable (if diagnostics are supported)?
6. Are the GA, DPT, feedback flag and binding mapping validated against the commissioning record?
7. Is the gateway reachable and is the TP line showing signs of wider failure?
8. Return a ranked, evidence-backed diagnosis: likely gateway/session fault, bus/coupler/line issue, device unreachable, group-address/DPT mismatch, no feedback object, state mismatch, or likely downstream actuator/load/wiring issue.

Never diagnose a lamp, relay contact, LED driver or load as physically failed using KNX telegrams alone. KNX can often narrow it to the boundary where an electrician should test voltage/load. If the actuator reports ON but the light remains off, recommend checking output status, mains, driver and load instead of repeatedly sending ON.

## Self-healing policy

Self-heal begins with low-risk recovery, not random writes:

- Transport: one in-flight connect attempt, bounded connect/response deadlines, tunnel liveness checks, exponential backoff + jitter, circuit breaker, reconnect counters and complete resource cleanup.
- After reconnect: restore subscriptions, perform a bounded read-back of configured status GAs, reconcile last-observed state and mark stale state honestly.
- Offline queue: command-specific merge keys, TTL expiry, cancellation of superseded commands, and a strict policy for safety-sensitive commands. Never blindly replay stale blind, lock, HVAC or security commands.
- Feedback pipeline: detect stale subscriptions, invalid telegrams, unmapped GAs, repeated DPT decode failures, duplicate individual addresses and abnormal bus traffic; alert without auto-writing.
- Self-heal action levels:
  - L0 observe and classify.
  - L1 retry idempotent transport operation once under bounded policy.
  - L2 reconnect the KNXnet/IP session and restore observers.
  - L3 resync known readable status objects, within rate limits.
  - L4 propose corrected mapping/configuration for installer approval.
  - L5 send control telegrams only with explicit homeowner/integrator policy and a validated safe action. Never reprogram devices, change individual addresses, write arbitrary GAs, bypass secure settings or reset hardware autonomously.
- Maintain an append-only recovery audit: trigger, evidence, policy, action, result, time, correlation ID and rollback/manual steps.

## Protocol implementation plan

### P0 — contract freeze + audit
- Freeze current production behaviour with adapter-level contract tests and baseline telemetry.
- Export the full package import graph and inspect generated bundles for direct/transitive `knxultimate` use.
- Extract a feature parity matrix from test files and deployed configs. Decide which security/mode features are release blockers.
- Define explicit transport-level interfaces for group write/read, telegram observation, diagnostics, connection state, and shutdown.

### P1 — Supreme-owned KNXnet/IP core
- Introduce `services/protocols/src/knx/native/` with independent byte-level frame codec, validated length fields, service-type parser, HPAI/DIB parsing, cEMI frame and APCI parsing.
- Build an injectable datagram/socket interface and deterministic fake router/interface.
- Implement tunnelling connection state machine with connect/disconnect, sequence/ack tracking, retries, heartbeat, out-of-order/duplicate detection and cleanup.
- Implement group communication and canonical telegram event model.
- Use the independent transport seam in the live driver, behind a feature flag. Do not simultaneously enable the legacy and new transport on one gateway unless explicitly isolated: duplicate command/observer sessions can cause real problems.
- Add bounded packet captures (metadata by default; payload opt-in), redact secure material and prohibit unbounded raw-telegram storage.

### P2 — DPT codec parity
- Keep SupremeOS capability mapping separate from wire DPT codecs.
- Build codecs with golden test vectors from the normative DPT definitions and ETS-derived fixtures authored by Supreme Domotics. Test ranges, reserved values, scaling, endianness, signedness, float special values, and invalid payloads.
- Generate a compatibility report against the current implementation in tests only; do not ship the old library as fallback.
- Implement DPTs proven by the parity inventory. Advertise unsupported DPT explicitly.

### P3 — health diagnostics and reports
- Add per-gateway, per-individual-address and per-GA test API.
- Schedule rate-limited diagnostic batches outside peak bus traffic; configurable maintenance window.
- Store bounded history and time-to-recover metrics. For every failed test include reason and evidence, not a single red/green light.
- Add a single-command diagnostic report export for service support.

### P4 — self-healing and simulator
- Deterministic tests for dropped packets, delayed ACK, wrong sequence, tunnel drop, group-read timeout, feedback on unexpected GA, stale state, duplicate responders, power loss/restart and long bus outages.
- Use a virtual KNXnet/IP router/bus simulator and optional physical gateway hardware-in-the-loop tests.
- Fault injection must not run against a live client's installation automatically.

### P5 — controlled migration and dependency removal
- New transport is opt-in in development/test.
- Shadow-observe passive telegrams where safe; do not dual-write commands.
- Canary on a non-critical test bench, then internal showroom, then a selected low-risk customer with rollback instructions.
- Compare command outcomes and actual status feedback; prove reboot, outage and recovery cases.
- Update all import paths and dependency files; regenerate lockfile with the repo's package manager; search for `knxultimate` across source, manifests, lockfiles, bundled JS, SBOM and container layers.
- Remove legacy provider/files only after the clean-room replacement supports every required production feature or the business explicitly accepts a documented feature gap.
- Create a release gate and retain rollback to the previous SupremeOS release, not to a second live control connection.

## Acceptance gates

1. Zero source/runtime/build/bundle references to `knxultimate` in the shipping artifact.
2. All parity inventory cases pass; no regressions in codec, importer, binding, feedback attribution, reconnect, unbind and HVAC/keypad flows.
3. Valid frames parse; malformed/oversized frames fail safely; fuzz tests do not crash the process.
4. Device reachability returns correct reachable/unreachable/indeterminate outcomes using simulated known replies/timeouts.
5. No user-visible state is emitted as observed merely because a write was sent.
6. Self-heal is bounded, cancellable, rate limited, auditable and never runs unsafe/stale commands after outage.
7. Tests pass on target hardware/OS across reboot, disconnected gateway, multicast restrictions and network-interface changes.
8. Security features are explicitly implemented and tested before being advertised. KNX IP Secure and Data Secure must not be represented as supported by default until keyring handling, crypto/session behaviour, persistence and conformance tests are complete.
9. Legal/provenance review signs off on the clean-room process and all shipped dependency licences/notices.

## Immediate instructions for Claude Code

Start by reading this file and the current handoff at `docs/architecture/knx-driver-handoff.md`. Work only on branch `feat/knx-clean-room-driver-foundation`.

Do not delete `knxultimate`, modify production bootstrap to cut over, or create a false "device ping" based on ICMP/group-read alone in the first change. First create the parity inventory and architecture/test harness. Implement P1 in small, reviewable commits after the harness is accepted. Every commit should include tests and update the matrix. Never call the new driver production-ready based solely on fake-bus tests.
