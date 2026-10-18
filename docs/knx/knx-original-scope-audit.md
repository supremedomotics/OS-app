# Supreme KNX — Original Scope Audit

2026-10-18 · branch `claude/great-keller-fmenbn` · base commit `b3b3289` · read-only audit; the only code that accompanies it is the separate health-monitoring milestone (`knx-device-health-design.md`).

**Goal of the product:** a native, production-grade KNX driver that replaces `knxultimate`, preserves existing SupremeOS functionality, and adds device-health monitoring, diagnostics and safe self-healing. KNX Secure is *one* of eighteen requirements; most of the last sessions went into it, so this audit re-centres on the whole scope.

**Sources of the requirement list.** The original brief (turn 1 of this engagement: replace `knxultimate`; audit; native stack; "Supreme KNX Health"; troubleshooting engine; self-healing; simulator; testing) and the 18-point list in the current task. The documents the first audit said the brief referenced (`supreme-knx-clean-room-driver-blueprint.md`, `KNX-CLEAN-ROOM-CLAUDE-PROMPT.md`) do not exist in the repository, so no requirement here is inferred from them.

## 0. Method and evidence vocabulary
Every row was checked by reading the cited file and counting the tests that exercise it. A feature is **Implemented** only with working behaviour *and* tests; a type, a doc mention or a simulator that accepts a message is not enough.
Status: **Implemented** · **Partial** · **Not implemented** · **Blocked** (by missing specification/hardware/data). Evidence (highest reached): **U** unit-tested · **S** simulator-tested · **V** specification-verified (worked examples or clause-level read of a supplied normative text) · **H** real-hardware-tested.
**H has not been reached by any requirement: no KNX IP interface, router, bus or device was available to this project at any point.** Production today = the legacy `KnxProtocolDriver` over `knxultimate`; the native stack is not wired to production (flags parser only).
Test counts below are from this session's runs (`@supreme/protocols`: `src/knx` 876 pass with licensed vectors / 854 pass + 22 skipped without (820/798+22 before the health milestone); `@supreme/commissioning` KNX: 97 pass). The `@supreme/gateway` KNX e2e suites (9 files) **could not be loaded in this sandbox** (`Failed to load url @supreme/protocols` — workspace dependency packages are not built here); they were last reported green in earlier sessions and are **not re-verified now**.

## 1. Requirement table (summary)

| # | Requirement | Status | Highest evidence | One-line reality |
|---|---|---|---|---|
| 1 | Gateway discovery + manual configuration | Implemented (classic) | U | own `node:dgram` SEARCH; manual host/port via env and driver config |
| 2 | Gateway identity/IP/port/IA/capabilities | Partial | U | IA, name, MAC, multicast, tunnelling/routing flags; no manufacturer, serial, secure families, tunnel-slot info |
| 3 | Gateway connectivity + lifecycle | Partial | S (native) / library (prod) | native tunnel client complete in simulator + loopback UDP; prod relies on `knxultimate` + gateway retry |
| 4 | Device health checks / pinging | **Not implemented before this milestone** → now **Partial**: passive + bounded GroupValueRead checks | S | simulator only; wiring to drivers/ETS not done |
| 5 | Online/offline/degraded/unknown with evidence + confidence | **Not implemented before** → now Partial | S | `confidence-engine.ts` scores *import mapping*, unrelated |
| 6 | GA read/write/response + live telegram monitoring | Partial | U/S | prod: write + declared-feedback observe only; reads/monitoring in provider + native client |
| 7 | DPT encode/decode + coverage | Partial | U + differential | 40+39 native tests; listed DPTs done, others explicit `unsupported_dpt`; prod still uses the library |
| 8 | Physical-address / individual-device management | **Not implemented** | – | no A_IndividualAddress_*/management code anywhere |
| 9 | KNX IP Secure | **Blocked** (components done) | V (crypto) + S | session client, frames, CCM, TCP socket verified; tunnelling over it simulator-only; Core/Overview/AN183/EITT missing |
| 10 | KNX Data Secure | **Blocked / Not implemented** | V (CCM primitive only) | Resources chapter and keyring format absent |
| 11 | ETS project import | Implemented | U (+ e2e earlier) | `.knxproj`, ESF, GA-export; real-ETS-file coverage unknown |
| 12 | Device/entity creation + SupremeOS mapping | Implemented | U | unified mapper, capability mapper, rooms, duplicates |
| 13 | Two-way sync + stale-state handling | Partial | U | feedback attribution + provenance done; no staleness/freshness model for entity state |
| 14 | Diagnostics, history, actionable errors | Partial | U | counters + last-telegram snapshot + feedback diagnostics; no troubleshooting engine, no event history |
| 15 | Safe recovery / reconnection / self-healing | Partial | U/S | backoff manager (commissioning provider only), offline queue (uniform TTL), native client single-use; no supervisor/self-healing engine |
| 16 | Auth, key management, privacy, local-only | Partial | U/V | key store, redaction, unlock providers verified; keyring import blocked; TPM unvalidated |
| 17 | Regression compatibility | Partial | U | legacy path untouched; protocols/commissioning suites green; gateway e2e not re-run |
| 18 | Testing, packaging, observability, migration off `knxultimate` | Partial | U | extensive tests; flags parser only; all removal gates open |

## 2. Detail per requirement

Notation: **Files** are repository-relative; **Tests** give file (count). "Next" = the smallest verifiable step.

### 1. Automatic discovery and manual configuration — Implemented (classic KNXnet/IP search)
* **Files:** `services/protocols/src/knx-discovery.ts` (`knxSearch`, `encodeSearchRequest`, `parseSearchResponse`, `listKnxNetworkInterfaces`), `lan-adapters/knx-discovery-remote-socket.ts` (hub-behind-NAT socket), exposed to installers at `services/gateway/src/installer-context.ts:1463`. Manual: `SUPREME_KNX_HOST`/`PORT` (`gateway/src/config.ts:264`, `bootstrap.ts:148`) and the driver-manifest factory (`gateway/src/native-driver-factory.ts:103`).
* **Tests:** `knx-discovery.test.ts` (10), `knx-discovery-remote-socket.test.ts`; factory test exists but is not loadable here. **Evidence: U** (fake sockets). No real gateway answered a SEARCH in this project.
* **Gaps:** no SEARCH_REQUEST_EXTENDED / secure-families DIB (Core v2 absent — IPS §2.6.2 names the DIB, Core defines the request); not rebased on `native/knxnetip-frame.ts`; multi-NIC behaviour untested on real networks.
* **Next:** optional — re-implement `knxSearch` on the native frame codec with the existing 10 tests as characterisation (no behaviour change).

### 2. Gateway identity, address, port, physical address, capabilities — Partial
* **Files:** `KnxGateway` in `knx-discovery.ts:25-47`: `address`, `port`, `individualAddress`, `name`, `multicastAddress?`, `macAddress?`, `tunnellingCapable|null`, `routingCapable|null` (from SUPP_SVC_FAMILIES, `null` when the DIB is absent — never guessed). **Tests:** `knx-discovery.test.ts`. **Evidence:** U.
* **Gaps:** manufacturer name, serial number, KNX Secure capability, number of tunnel connections/slots and their addresses (Tunnelling §4/DESCRIPTION DIBs) are not reported; DESCRIPTION_REQUEST is not implemented. Exact DIB layouts for these are in Core/Overview (absent).
* **Next (blocked on Core 3/8/2):** DESCRIPTION_REQUEST + DIB parsing; until then keep reporting `null`.

### 3. Gateway connectivity and connection lifecycle — Partial
* **Production:** `knx-driver.ts` `wrapKnxUltimate` (connect with leak-free failure cleanup, disconnect) over `knxultimate`; reconnection is driven by the gateway's driver retry (not re-verified here). **Native:** `native/tunnel-client.ts` (connect, ACK/retry, heartbeat, single-use, DISCONNECT on ack failure) — `tunnel-client.test.ts` (37), `tunnel-client.wire.test.ts` (11), `udp-socket.test.ts` (3); `connection-manager.ts` (9) supervises only `KnxUltimateProvider` (commissioning path).
* **Evidence:** S + loopback UDP; **H: none**. Behaviour against real gateways (announced data endpoint, NAT, tunnel-slot exhaustion, firmware quirks) is unknown.
* **Gaps:** no native supervisor that rebuilds a fresh client with restored subscriptions; production driver does not use `ConnectionManager`.
* **Next:** `NativeConnectionSupervisor` (fresh `KnxTunnelClient` per attempt, backoff reusing `ConnectionManager`) with simulator outage/reboot tests.

### 4. Device health checks — Partial (implemented in this milestone; simulator-validated only)
* **Before:** nothing checked a device's responsiveness; the only `isHealthy` hook (`ConnectionManager`) tests the gateway link.
* **Now:** `services/protocols/src/knx/health/` — `health-model.ts` (pure rules), `health-monitor.ts` (evidence collection, bounded active GroupValueRead checks, load control), `tunnel-health-adapter.ts` (native tunnel client → monitor, read-only bus port). Design, evidence classes and rule table: `docs/knx/knx-device-health-design.md`.
* **Mechanisms actually used:** passive telegram whose source address is the device (N for individual/broadcast services, I for group frames — cEMI chapter not supplied); active GroupValueRead of the device's own readable status object (AL v02.01.01 §3.1.2: a response is *optional*, so silence proves nothing). Not used: ICMP, A_DeviceDescriptor_Read (connection-oriented only mandatory; needs the Transport Layer client and individually-addressed cEMI — deferred).
* **Tests:** `health-model.test.ts` (14), `health-monitor.test.ts` (33), `health-simulator.test.ts` (9) = 56; mutation-checked (9 rule/limit mutations each failed named tests). **Evidence: S.** No real gateway or device.
* **Gaps:** not wired to any driver, gateway route or UI; no ETS-driven registration beyond a structural helper (`monitoredDeviceFromEts`); no persistence of health history; secure installations: probing disabled by flag (no Data Secure support).
* **Next:** register devices from the ETS import + supervisor-managed tunnel (reconnect re-attaches the monitor); expose `snapshot()`/events through a diagnostics endpoint.

### 5. Online / offline / degraded / unknown with evidence and confidence — Partial (same milestone)
`health-model.ts` `evaluateDevice` implements the ordered rule table (12 rules) with `state`, `confidence` (high/medium/low/none) and a `reason` code; `DeviceHealth` records `lastSeenAt`, `lastSeenKind`, `lastResponseAt`, latency, `consecutiveFailures`, `checkMethod`, `lastCheck`, `nextCheckAt`; a bounded event log records every transition. `offline` requires: repeated conclusive active failures + prior proof the device answers reads + a long silence window + a healthy path. Evidence **S**; thresholds are decisions (I), configurable, not specification values.

### 6. Group-address reads, writes, responses, live monitoring — Partial
* **Production:** `knx-driver.ts` — writes (commands), observes only declared feedback GAs, never attributes command-GA traffic (`hasFeedback`); `KnxConnection` has **no read** and exposes no source address. **Provider:** `KnxUltimateProvider` — `read(ga)`, bounded last-telegram snapshot, counters (`diagnostics()` lines 380-400); `SupremeKnxDriver` can trigger group reads for sync. **Native:** `tunnel-client.ts` `sendGroup` (read/write/response), telegram stream with source IA (`onTelegram`), `cemi.ts` (14).
* **Tests:** `knx-driver.test.ts` (121), `knx-ultimate-provider.test.ts` (18), `command-feedback-binding.e2e.test.ts` (17), `supreme-knx-driver.test.ts` (36), native tests above. **Evidence:** U/S.
* **Gaps:** no live telegram monitor API/stream for the UI (no gateway route); native telegram bus (multi-subscriber, per-handle unsubscribe — legacy defect D4) not built; no individually-addressed (point-to-point) frames in `cemi.ts` (group only).
* **Next:** native `TelegramBus` (multi-subscriber, bounded history, per-handle unsubscribe) with the legacy feedback-attribution tests ported.

### 7. DPT encoding/decoding — Partial
* **Files:** `native/dpt.ts`; legacy `knx-codec.ts`. **Tests:** `dpt.test.ts` (40), `dpt-differential.test.ts` (39, auto-skips when the library is gone). Done: 1, 5, 6, 7, 8, 9, 12, 13, 14, 17.001, 20.102/105, 22.101 (raw number, fixes D1), 222.100 (fixes D2), 232.600, 251.600. **Explicitly unsupported** (`unsupported_dpt`): 2, 3 (3.007/008), 4, 10, 11, 16, 18, 19, 29. Known legacy defect D3 (0x7FFF "invalid" decodes as a reading) is fixed only in the native codec.
* **Evidence:** U + differential vs the library; **no KNX DPT specification document was supplied**, so DPT correctness rests on the library oracle and golden vectors, not on a read of the standard.
* **Next:** add DPT 3.007/3.008, 10/11, 16 only when a use is confirmed from field data; obtain the DPT chapter for V.

### 8. Physical-address and individual-device management — Not implemented
No A_IndividualAddress_Read/Write, device descriptor, memory/property services or programming-mode handling exist. The Application Layer v02.01.01 (supplied) defines the PDUs (N) and marks several of them mandatory **only in connection-oriented mode** (e.g. A_DeviceDescriptor_Read: T_Data_Individual **O**, T_Data_Connected **M**); a client therefore needs the Transport Layer connection state machine (T_Connect, numbered data, ACK/NAK, timeouts — Transport Layer v01.02.03 supplied) and individually-addressed cEMI frames (cEMI chapter **not** supplied).
* **Next (blocked on cEMI + design):** individually-addressed L_Data encoding + a transport-layer connection client; first use: A_DeviceDescriptor_Read as an *optional* health check (health design §5, deferred).

### 9. KNX IP Secure — Blocked (components implemented and verified; no usable path)
* **Done:** KNX CCM (`secure/ccm.ts`), key derivation (`ip-keys.ts`), frame codecs (`ip-frames.ts`), session client (`ip-session.ts`), stream deframer, real TCP socket (`tcp-socket.ts`), simulator-only secure-stream tunnel (`secure-stream-link.ts`, `tunnel-rules.ts`). **Tests:** secure suite 152 (130 + 22 vector tests skipped without the licensed file), `tcp-socket.test.ts` (24), `stream-tunnel.test.ts` (27), `stream-replay.test.ts` (14), `delivery-semantics.test.ts` (9). **Evidence:** V (specification worked examples reproduced), S, loopback TCP; **H none; no conformance run.**
* **Blocked:** B1 (Overview status codes), B3 (TCP HPAI), B4 (liveness), B5 (disconnect/slot cleanup), B8 (partial frames) need Core 3/8/2 + Overview; B2 AN183; B6 password encoding (guarded); B9 client serial. Real transport use is refused at construction (`tunnel-rules.ts`). Detail: `docs/architecture/knx-secure-blocker-matrix.md`.
* **Next:** obtain the documents (list in `knx-secure-spec-acquisition.md` §D), then map B3/B4/B5/B8 to clauses and tests.

### 10. KNX Data Secure — Blocked / Not implemented
CCM with 4-octet MAC verified against the Application Layer's worked examples (C.1.1–C.1.4); S-AL §5 read; **nothing else**: no SCF handling, sequence-number store, S-A_Sync, group key table (Resources 3/5/1 absent), keyring parser (format absent). **Next:** documents first; no code until then.

### 11. ETS project import — Implemented (fixture-level)
* **Files:** `services/commissioning/src/knx/` — `ets-parser.ts` (.knxproj XML: topology, device instances with individual address and communication objects with R/W/T/U flags, GA records), `esf-parser.ts`, `ga-export-parser.ts`, `zip-reader.ts`, `name-cleanup.ts`; encrypted-project handling `commissioning/src/knx-crypto.ts` (5 tests). **Tests:** 97 passing in `commissioning/src/knx` (e.g. ets-parser 8, device-recognition 35, index 16); gateway e2e (`knx-import`, `chunked-upload`, `worker-timeout`) exist but are not runnable here. **Evidence:** U (+ e2e earlier).
* **Gaps:** whether real customer ETS6 exports are covered is unknown (fixtures are synthetic/hand-built per tests); no secure-project/keyring import (blocked).
* **Next:** collect 2–3 anonymised real `.knxproj` files as regression fixtures.

### 12. Device/entity creation and SupremeOS mapping — Implemented
`services/protocols/src/knx/unified-device-mapper.ts` (99 tests), `capability-mapper.ts` (33), `schema-engine.ts` (19), `room-assignment*.ts` (9 + 6), `duplicate-detection.ts` (6), `device-synthesis-audit.test.ts` (15), `commissioning/src/knx/entity-generator.ts`/`device-card-generator.ts`/`room-assignment-engine.ts`; production binding `binding-engine.ts` (17). **Evidence:** U. **Gap:** none identified at unit level; behaviour on real installations unknown. **Next:** none for this milestone.

### 13. Two-way state synchronisation and stale-state handling — Partial
* **Done:** command ≠ state (`commanded` vs `observed` provenance, `knx-driver.ts`), feedback only from declared status GAs, HVAC overlay, initial-read trigger in `SupremeKnxDriver` (`knx-driver.test.ts` 121, `command-feedback-binding.e2e` 17; gateway `knx-state-provenance.e2e` not runnable here).
* **Gaps:** no per-state freshness timestamp/expiry policy; the production driver cannot read (no read in `KnxConnection`), so cold-start values depend on the device publishing; native stack has no state facade yet.
* **Next:** state-freshness model (last-observed time + configurable validity per capability) — the health milestone provides device-level liveness evidence this can build on.

### 14. Diagnostics, event history, actionable errors — Partial
`KnxUltimateProvider.diagnostics()` (packets, last telegram, reconnect counts), `driver-diagnostics.ts` (generic tracker, 9 tests; used by AV drivers), gateway `knx-feedback-diagnostics.e2e` (not runnable here), native tunnel `diagnostics()` (framesSent, acks, heartbeat RTT, malformed counters). **Not implemented:** troubleshooting engine (original brief), persisted event history, error-to-action mapping. **Next:** health event log (bounded ring) — introduced by the health milestone as the first producer.

### 15. Safe recovery, reconnection and self-healing — Partial
`connection-manager.ts` (backoff + jitter + heartbeat, 9 tests; commissioning provider only), `offline-command-queue.ts` (7 tests; **uniform 5-minute TTL**, no never-replay class — replays locks/blinds like lights; wired only into `SupremeKnxDriver`), native `tunnel-client.ts` (single-use by design). **Not implemented:** native supervisor, per-capability replay policy (design: `docs/architecture/knx-secure-retry-policy-design.md`), self-healing actions. **Next:** supervisor, then the retry policy engine from the design.

### 16. Authentication, key management, privacy, local-only operation — Partial
`native/security/` — `secret.ts` (redaction/wipe), `keystore.ts` (scrypt + AES-256-GCM, unlock-mode binding), `unlock.ts` (passphrase / key file / TPM seam), `import-activation.ts`, `policy.ts` (fail-closed); `security.test.ts` (17), `keystore-hardening.test.ts` (22); secure session credentials handled as `Secret`. Local-only: discovery and tunnelling talk only to configured/LAN endpoints; no cloud dependency in the KNX path. **Not done:** keyring import (format absent), TPM driver (BLOCKED-HW), independent security review of the key store. **Evidence:** U/V (crypto). **Next:** none without the keyring format.

### 17. Regression compatibility — Partial
Legacy `KnxProtocolDriver`/`SupremeKnxDriver` untouched by the native work (git: no change to `knx-driver.ts`, `supreme-knx-driver.ts`, `package.json`, lockfile since the clean-room stage began). Current runs: protocols `src/knx` 820/820 with vectors; commissioning KNX 97/97. **Not re-verified this session:** gateway KNX e2e (unloadable here). **Next:** run the gateway e2e in a fully built workspace as a gate before any flag flip.

### 18. Testing, packaging, observability and migration — Partial
Native code: ~920 tests across the KNX trees (protocols 820 + commissioning 97), simulator suite, mutation checks on security paths; feature-flag parser (`native-flags.ts`, default OFF) with **no driver adapter consuming it**; `docs/architecture/knx-removal-gates.md`: G1–G14 all OPEN/PARTIAL/BLOCKED; `knxultimate` present in source (two import sites), manifest and lockfile. Observability = counters only (no metrics export/log schema). **Next:** the adapter (`KnxConnection` implemented over the native client with parity tests against `knx-driver.test.ts`), then shadow mode.

## 3. What is missing for feature parity with `knxultimate` (ordered)
0. Wire the health monitor (req 4/5) to ETS-registered devices and the native supervisor. 1. Native `TelegramBus` + read/write facade with the legacy semantics (req 6, 13). 2. Native supervisor (req 3, 15). 3. `KnxConnection` adapter + parity tests vs the 121 driver tests (req 18). 4. Individually-addressed frames (req 8) — only if a feature needs them. 5. Routing is **not** used by the legacy driver (both sites hard-code TunnelUDP) and is not required for parity. 6. Secure (req 9, 10) is *beyond* the library's behaviour in this codebase (never wired) but is a mandatory product requirement: blocked on documents/hardware. 7. Hardware-in-the-loop for every row (gate G5).

## 4. Evidence ceiling
Nothing in this audit is hardware-validated. Specification-verified items are limited to the IP Secure cryptography/framing worked examples, Tunnelling §2.6.x rules, and the clauses cited in the secure documents. Everything else rests on unit tests, simulators and the `knxultimate` oracle.
