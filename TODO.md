# TODO.md — SupremeOS Engineering Backlog

> Prioritized backlog. When work completes, **move it to Completed — never delete it.** This is
> project history, not a scratchpad. For "what changed most recently," see `SESSION_HANDOFF.md`.

---

## Critical

### Real-world deployment readiness gap
- **Description:** `docs/production-readiness.md`'s own assessment: feature-complete
  development is ~80%, but real-world deployment readiness is ~25–30%. Nothing has run against
  real field-bus hardware, an unattended multi-week soak, real cloud providers, or a security
  audit.
- **Reason:** shipping without closing this gap risks the product failing in the field in ways
  unit/integration tests can't catch.
- **Dependencies:** none — this is the top-level gate.
- **Complexity:** Large (multi-session).
- **Status:** Not started. Recommended order from the doc itself: (1) security hardening →
  (2) real HA integration → (3) wire real Redis/NATS + persist remaining state → (4) cloud IaC +
  CD + observability → (5) real drivers/protocols + remote-access relay against live hardware.

### App-wide density-breakpoint remount bug
- **Description:** Resizing the browser across the `expanded`↔`comfortable` boundary (~1200px)
  mid-session remounts `App.tsx`'s entire page tree (two structurally different root trees for
  `wide` true/false), silently discarding in-page navigation state.
- **Reason:** real, reproducible; affects every page in the app, not just newly-built ones.
- **Dependencies:** none.
- **Complexity:** Medium — likely fixable by hoisting the page content into one stable render
  path shared by both the sidebar and bottom-tab shells, rather than branching the whole return.
- **Status:** Diagnosed, not fixed. Found during Security/Media module Playwright verification.

---

## High

### Casambi Local Gateway — RGBW/CCT capability inference for Local mode
- **Description:** `local-discovery.ts` (real, PR-2) deliberately does NOT map NotifyControlValues
  control types 2 (Color Temperature), 3 (Hue/Saturation), 4 (XY color), 5 (Color Source
  Selector), or 11 (White channel) into Supreme's `color` capability. Type 2's documented byte
  layout is one byte with no stated Kelvin range or normalization at the NotifyControlValues
  layer — unlike the SET-side opcode 0x48, which explicitly documents either raw Kelvin
  (0x400-0x4000) or a separate 0x00-0xFF normalized form. Guessing which encoding a real gateway
  actually reports would be fabrication, not implementation.
- **Reason:** without this, a dimmable-and-color-capable Casambi luminaire commissioned over
  Local Gateway only ever exposes `onoff`/`brightness` — color control silently unavailable
  (correctly gated, per `CapabilityGate`, but a real functionality gap).
- **Dependencies:** real Lithernet hardware to observe what a gateway actually sends for type 2/3/4
  in practice — this cannot be resolved from documentation alone.
- **Complexity:** Medium, once the real byte semantics are confirmed against hardware.
- **Status:** Not started; honestly gated (never fabricated) as of PR-2.

### supreme-lan Phase 2 — real Lithernet hardware retest of the (now-default) Casambi transport
- **Description:** Phase 2 is CODE-COMPLETE — `CasambiUdpEngine` no longer owns a raw socket;
  `CasambiUdpSocketLike` is deleted; the Casambi Local Gateway driver now DEFAULTS through
  `@supreme/lan` (`NatsUdpTransportClient` when NATS is configured, `LocalDirectUdpTransport`
  otherwise), resolved centrally in `installer-context.ts`. A follow-up session with real Docker
  access reproduced the ACTUAL bridge-vs-host broadcast bug for real (a genuine UDP broadcast was
  dropped in bridge mode, received in host mode — see architecture doc §10.3) and fixed two real
  bugs found in the process (`lan.Dockerfile` missing `cloud`/`drivers`/`tools`; the
  `nats-loopback.yml` port publish being a no-op on an `internal: true`-only network). What's
  STILL not done: the identical test against a REAL Lithernet gateway on a real physical LAN —
  a synthetic broadcast from a script proves the Docker/networking mechanism, not a real device.
- **Reason:** the whole point of this refactor was fixing real LAN broadcast reception that a real
  Wireshark capture proved was being silently dropped by Docker bridge networking. Reproducing the
  mechanism on synthetic traffic is strong evidence but not the same as confirming against the
  actual device — the migration being internally correct AND mechanism-proven is still not the
  same as hardware-confirmed.
- **Dependencies:** a real Lithernet Gateway + a Linux host running the `docker-compose.
  lan-host.yml`/`docker-compose.nats-loopback.yml` overlays (both now confirmed to actually boot
  and connect for real); confirm `GET /v1/drivers/:id/casambi/transport-monitor` shows nonzero
  `adapter.packetsReceived` from real broadcast traffic from the real device.
- **Complexity:** Small (no further code expected) — pure verification.
- **Status:** Blocked on hardware access. Per the governing brief's Critical Requirement, KNX/
  Matter/other LAN protocol migrations (Phases 3-5) stay on hold until this passes.

### Transport Monitor — dedicated UI page
- **Description:** The Transport Monitor backend (`CasambiProtocolDriver.
  getCasambiTransportMonitor()`, `GET /v1/drivers/:id/casambi/transport-monitor`) is implemented
  and tested, but has no dedicated UI page yet — Phase 2's "do not modify the Driver Manager UI"
  constraint means it needs its own new page, not an addition to `drivers.tsx`'s existing
  diagnostics panel.
- **Reason:** the user asked for this to become "the primary debugging tool for every LAN
  protocol" — a backend-only endpoint doesn't deliver that on its own.
- **Dependencies:** none technically, but per CLAUDE.md's UI standards a new page needs real
  Aureon-token styling and Playwright-verified responsive testing at all four density tiers before
  being considered done — deliberately not rushed into this session alongside the backend work.
- **Complexity:** Small — the data shape already matches the four-section layout requested; this
  is presentation work, not new backend logic.
- **Status:** Not started.

### supreme-lan Phase 3a — default KNX Discovery onto the remote transport
- **Description:** `services/protocols/src/lan-adapters/knx-discovery-remote-socket.ts` is built
  and unit-tested (including the two-phase bind-then-`setMulticast` sequence `knxSearch()` actually
  uses), but not wired as `knxSearch`'s default `createSocket`.
- **Reason:** same Docker-bridge-drops-broadcast problem affects KNX/IP Discovery's multicast
  `SEARCH_REQUEST` to `224.0.23.12` exactly like it affected Casambi.
- **Dependencies:** a real KNX/IP interface + a Linux host running the `lan-host` overlay.
- **Complexity:** Small.
- **Status:** Not started.

### supreme-lan Phase 3b — KNX Routing needs its own protocol-level seam first
- **Description:** Unlike KNX Discovery, KNX's main tunneling/routing driver (`knx-driver.ts`,
  `knx/knx-ultimate-provider.ts`) delegates socket ownership entirely to the third-party
  `knxultimate` npm package — there is no injectable raw-socket seam today for `supreme-lan`'s
  generic transport to slot into.
- **Reason:** KNX Routing also relies on multicast (`224.0.23.12:3671`) and hits the identical
  Docker-bridge failure — but fixing it needs real investigation into whether `knxultimate`
  exposes any custom-socket hook, or whether it needs forking/patching, BEFORE any transport swap
  is possible. Not something Phase 1's generic transport layer can absorb for free.
- **Dependencies:** research into `knxultimate`'s internals; possibly a request/PR upstream.
- **Complexity:** Large.
- **Status:** Not started; genuinely harder than a factory swap — disclosed as such, not
  downplayed.

### supreme-lan Phase 4 — Matter (mDNS-based commissioning) onto the remote transport
- **Description:** No real Matter controller is wired in yet (`matter-driver.ts`'s
  `defaultMatterController()` throws) — when `@matter/main` is integrated, it will own its own
  sockets internally, the same class of problem as KNX Routing (no injectable seam without
  investigating the library's internals first).
- **Reason:** Matter commissioning is fundamentally mDNS-based and will hit the identical
  Docker-bridge multicast failure the moment a real controller exists.
- **Dependencies:** the real Matter controller integration itself (a separate, larger project —
  see `docs/architecture/adr/0011-matter-commissioning-and-fabric-seams.md`) has to land first.
- **Complexity:** Large.
- **Status:** Not started.

### supreme-lan Phase 5 — remaining mDNS/SSDP consumers onto the remote transport
- **Description:** `mdns-remote-socket.ts`/`ssdp-remote-socket.ts` are built and tested, but not
  wired as the default for any of their consumers (Sonos, Denon HEOS, Apple TV, Hue, Shelly,
  AirPlay, WiiM — everything using `mdnsBrowse`/`ssdpSearch`).
- **Reason:** same Docker-bridge multicast problem affects every mDNS/SSDP-based discovery flow.
- **Dependencies:** none architecturally — small, low-risk, one consumer at a time.
- **Complexity:** Small per consumer.
- **Status:** Not started.

### Casambi Local Gateway — confirm the UDP receive fix against real hardware (firmware 6.25)
- **Description:** A real Wireshark capture showed the Lithernet Gateway broadcasting to
  `255.255.255.255:10009` while SupremeOS reported `Packets Received = 0`. Code audit found no
  reception-blocking bug (no filter, no `connect()`) and the fix targets a real, confirmed gap:
  `packetsReceived` only counted successfully-decoded packets, hiding the difference between "no
  datagram arrived" and "a datagram arrived but failed to parse." The exact reported payload
  decodes successfully against the current, unmodified codec once manually reconstructed to its
  stated length.
- **Reason:** without a real gateway, this session cannot confirm the original symptom is now
  actually resolved end-to-end — only that the diagnostic blind spot is closed and the
  reconstructed real payload decodes correctly in isolation.
- **Dependencies:** the same Lithernet Gateway (firmware 6.25) used for the original capture.
- **Complexity:** Small — re-run SupremeOS against it and check the new Diagnostics packet-trace
  table / `onRawDatagram` trace log directly.
- **Status:** Not started; disclosed in `docs/architecture/Casambi-UDP-Receive-Pipeline-Audit.md`.

### Casambi Local Gateway — confirm HTTP auth scheme (Basic vs Digest) against real hardware
- **Description:** `Lithernet_General_Settings_Network.pdf` p.109 shows a native browser
  credential prompt guarding a direct HTTP endpoint but never names the wire scheme. HTTP Basic
  Authentication was implemented as the disclosed, informed default (it's the standard mechanism
  that produces exactly that prompt), but this has not been verified against a real gateway. If a
  real device expects Digest instead, `rest-client.ts`'s `authHeaders()` needs updating.
- **Reason:** an unverified auth scheme could silently fail against real hardware even though it
  looks correct in code and unit tests (which only exercise the client's own request-building
  logic, not a real gateway's response to it).
- **Dependencies:** a real Lithernet Gateway to test against.
- **Complexity:** Small, once hardware is available.
- **Status:** Not started; disclosed in `docs/architecture/Casambi-Local-Auth-And-UDP-Diagnostics.md`.

### Casambi Local Gateway — SSL/HTTPS support for the Local REST client
- **Description:** The gateway's embedded web server optionally supports HTTPS with either a
  self-signed cert (valid to 2046) or an installer-uploaded custom cert (`Lithernet_General_
  Settings_Network.pdf` p.64-65). `CasambiLocalRestClient` is HTTP-only; `restPort`'s help text
  notes the 443/SSL possibility but SupremeOS cannot actually speak HTTPS to the gateway yet
  (and would need a self-signed-cert trust decision if it did).
- **Reason:** an installer who has enabled SSL on their gateway's web server cannot use Local REST
  from SupremeOS at all today — a real, disclosed functionality gap, not a rare edge case (the
  Lithernet UI makes enabling it one toggle).
- **Dependencies:** none architecturally; needs a design decision on self-signed cert trust.
- **Complexity:** Medium.
- **Status:** Not started.

### Casambi Local Gateway — HTTP-level test for the rewritten Test Connection route
- **Description:** `/v1/commissioning/casambi/test-connection`'s staged rewrite (§ Auth & UDP
  Diagnostics session) is thin orchestration over already-unit-tested primitives
  (`CasambiLocalRestClient.testConnection()`, `CasambiUdpEngine.probe()`/counters), but the route
  itself — request parsing, the missing-fields early return, the combined message string — has no
  dedicated fastify-level integration test.
- **Reason:** a route-shape regression (e.g. a renamed response field) wouldn't be caught by the
  underlying unit tests alone.
- **Dependencies:** none.
- **Complexity:** Small.
- **Status:** Not started; disclosed gap from the Auth & UDP Diagnostics session.

### Casambi Local Gateway — migrate `casambi-driver.ts` onto the SupremeOS Core Event Bus
- **Description:** PR-2 built `services/protocols/src/core/event-bus.ts` (`CoreEventBus`, the
  cross-driver 13-category taxonomy) but `casambi-driver.ts` still publishes through the
  Foundation-session, Casambi-only `event-engine.ts`'s `CasambiEventBus` — deliberately not
  migrated in the same PR that added real Local UDP, to avoid re-touching tested Cloud
  event-emission code paths alongside a large new Local implementation. The subsequent
  Architecture Validation audit (`docs/architecture/Casambi-Architecture-Audit.md`) confirmed this
  gap still stands and named it explicitly as one of two reasons Casambi cannot yet be declared
  the standard template for future drivers.
- **Reason:** the whole point of the Core Event Bus is "every driver publishes through the SAME
  bus" (§ PR-2 brief's Cross-Protocol Philosophy) — Casambi not being on it yet is the one
  driver-side gap in that promise, and until ONE driver proves it end-to-end, `CoreEventBus` is
  untested-by-real-use even though it has unit tests of its own.
- **Dependencies:** none architecturally; needs its own regression pass against
  `casambi-driver.test.ts`'s existing Cloud-mode event assertions. The new `CasambiSignal`
  normalization layer (`event-engine.ts`'s `normalizeCloudEvent`/`normalizeLocalPacket`, added by
  the Architecture Validation audit) is the natural seam to publish `CoreDriverEvent`s from,
  alongside (or instead of) the existing `CasambiEventBus` publish calls in `applySignal`.
- **Complexity:** Medium.
- **Status:** Not started.

### Casambi Local Gateway — wire `entity-mapper.ts` onto `core/capability-engine.ts`
- **Description:** found during the Architecture Validation audit: `core/capability-engine.ts`'s
  `computeEntityCapabilities()` exists, is tested, and is meant to be the ONE place every driver
  turns a device's real capabilities into UI-facing boolean flags — but `entity-mapper.ts`'s
  `capabilitiesFromUnit()` computes Casambi's capabilities its own way, independently, and nothing
  in this driver calls `computeEntityCapabilities()` at all. The Capability Engine layer exists in
  the codebase with zero real consumers, Casambi included.
- **Reason:** named explicitly in the audit doc's §7 template-readiness table as the second of two
  reasons Casambi is not yet confirmed ready to be the standard template for future drivers (KNX/
  Matter/Lutron/RTI/Denon/DALI/Apple TV/Bluetooth/MQTT) — a driver copying Casambi today would
  copy a working pattern that bypasses the shared engine meant to replace it.
- **Dependencies:** none architecturally. `capabilitiesFromUnit`'s OUTPUT (a `CapabilityKind[]`)
  is exactly `computeEntityCapabilities`'s INPUT shape (`CapabilitySnapshot.capabilities`) — this
  should be closer to "wire the two together and expose the flags somewhere real consumes them"
  than a rewrite of either.
- **Complexity:** Small–Medium.
- **Status:** Not started.

### Casambi Local Gateway — wire the real UDP engine into the Packet Recorder Framework
- **Description:** `core/packet-recorder.ts` (`PacketRecorder`, PR-2) is a real, tested ring
  buffer, but nothing feeds it yet — `local-transport/udp-engine.ts`'s real send/receive paths
  don't record into it. The Driver Manager UI's "Packet Capture" toggle is still an honestly
  disabled placeholder for this reason.
- **Reason:** needed before Packet Capture can go from a disabled checkbox to a real feature.
- **Dependencies:** none — the recorder and the engine both exist; this is pure wiring +
  redaction review (packets never carry credentials for this protocol, but confirm before
  shipping "Save Diagnostic Data" export).
- **Complexity:** Small–Medium.
- **Status:** Not started.

### Casambi Local Gateway — reconnect/health-recovery loop for Local mode
- **Description:** Cloud mode has a real capped-exponential-backoff reconnect loop
  (`scheduleReconnect`/`reconnect` in `casambi-driver.ts`, unchanged since Foundation). Local mode
  has none — UDP is connectionless, so a lost socket or an unresponsive gateway isn't detected or
  recovered from automatically today.
- **Reason:** a real Lithernet gateway rebooting or losing power should be detected and recovered
  from without requiring the installer to manually reconnect the driver.
- **Dependencies:** design decision on what "connection health" even means for a connectionless
  protocol on a LAN (a periodic `probe()` heartbeat is the obvious candidate — `udp-engine.ts`'s
  `probe()` already exists and is reused by Test Connection; the driver doesn't call it
  periodically yet).
- **Complexity:** Medium.
- **Status:** Not started.

### Casambi Local Gateway — verify against real Lithernet hardware
- **Description:** PR-2's UDP codec/engine/REST client are byte-exact against the documentation
  (39 codec tests, several matching the PDF's own worked examples byte-for-byte) but have never
  touched a real Lithernet Gateway. Several features are firmware-gated per the doc (Evolution
  ≥33.22 Scene status, ≥34.50 Target status, ≥36.70 Target Color/SetColorTemperature, ≥37.80 Resume
  Automation, ≥37.90 NotifyControlValues, ≥39.50 NotifyButtonEvent) — whether a given gateway
  silently ignores an unsupported opcode (as the doc claims for "unknown opcodes") is unverified.
- **Reason:** the single most load-bearing unverified assumption in this implementation.
- **Dependencies:** physical access to a Lithernet gateway + Casambi network.
- **Complexity:** Medium (mostly verification, not new code, unless real behavior diverges from
  the documentation — in which case see the flagged inconsistencies in `udp-codec.ts`'s doc
  comments first).
- **Status:** Not started.

### Universal Keypad Editor / Intent-aware mapping UI
- **Description:** Phase 1 (ADR 0016) and Phase 2 (ADR 0017) both shipped complete backend
  architecture — Universal Input/Feedback Engines, Subscription Manager, Mapping Engine, and the
  Intent & Capability Engine (42-intent registry, capability resolution, REST API) — with
  explicitly no visual editor. A homeowner/installer cannot author a `ToggleLight`/`Movie Mode`
  style mapping through any UI today, even though the backend already fully executes it.
- **Reason:** the backend is now complete enough (both phases) that a real editor has something
  substantive to build against — this is the natural next UI investment, not a premature one.
- **Dependencies:** at least one real keypad driver (see below) makes the editor demonstrable
  end-to-end, but is not strictly required to start (intents can already target existing
  KNX/Casambi/etc. device capabilities via room/device targets today).
- **Complexity:** Large — needs its own scoped session/ADR (visual node/pipeline editor, likely
  extending the existing Automation Editor's canvas rather than a wholly separate surface, given
  `KeypadMapping`/`Automation` now share one `AutomationAction` vocabulary including `"intent"`).
- **Status:** Not started; fully documented as future work in both ADR 0016 and ADR 0017.

### Universal Intent & Capability Engine: fill the honest capability gaps
- **Description:** `swingMode`/`tiltUp`/`tiltDown`/`executeScript`/`webhook` are registered in the
  Intent Registry but their execution honestly throws — no swing/tilt field exists in
  `TemperatureState`/`PositionState` yet, and no script engine or webhook dispatcher exists.
- **Reason:** these are real, named gaps in the capability model / platform infrastructure, not
  hypothetical — a genuine venetian-blind installation or a "run this automation via webhook"
  marketplace template would hit them today.
- **Dependencies:** the tilt/swing gap needs a deliberate `TemperatureState`/`PositionState` schema
  addition (additive, low risk, but a real capability-model decision, not a one-line fix);
  executeScript/webhook need actual new infrastructure (a script sandbox, an outbound HTTP
  dispatcher) — each a meaningfully-sized feature in its own right.
- **Complexity:** Medium (tilt/swing, per capability) to Large (script engine / webhook dispatcher).
- **Status:** Not started; honestly documented as incomplete rather than faked, per ADR 0017.

### Universal Keypad Framework: first real keypad driver
- **Description:** ADR 0016 shipped the full protocol-independent input/feedback/mapping
  framework (Phase 1: architecture only) — no real keypad driver exists yet. `docs/architecture/
  Keypad-Driver-Author-Guide.md` lists per-protocol hypotheses (KNX push-button, Casambi keypad,
  Lutron Pico, Matter switch, MQTT button, RTI keypad, Zigbee remote, BLE, DALI push-button unit),
  explicitly flagged as unverified — no spec-verification research has been done for any of them.
- **Reason:** the framework has zero real-world value until at least one real driver plugs into it.
- **Dependencies:** none architecturally — the seam (`getKeypadCapabilities?`/`onInputEvent?`/
  `sendKeypadFeedback?` on `INativeProtocolDriver`) is ready and proven via a synthetic
  extensibility test. Lutron is the most natural first target (its LIP transport already exists in
  `lutron-driver.ts`).
- **Complexity:** Medium per protocol (spec verification + codec + tests, same shape as adding a
  new AVR brand).
- **Status:** Not started, framework ready.

### Universal Keypad Framework: Postgres-backed persistence
- **Description:** `IKeypadMappingStore`/`IKeypadSubscriptionStore` (`@supreme/keypad-framework`)
  default to in-memory only (mirrors `InMemoryAutomationStore`'s exact pre-persistence-era shape).
  A hub restart today loses every keypad mapping/subscription.
- **Reason:** real deployment readiness — same gap automations had before its own store was wired
  to `services/persistence`/`cloud/persistence`.
- **Dependencies:** none — small, additive, follows the automations repo's exact existing pattern.
- **Complexity:** Small–Medium.
- **Status:** Not started.

### Universal Keypad Editor (visual UI)
- **Description:** the Mapping Engine Interface's backend APIs
  (`/v1/keypad/mappings*`/`/v1/keypad/subscriptions*`) are built and tested; no visual editor
  exists — explicitly out of Phase 1 scope per the brief.
- **Reason:** installers/homeowners need a UI to actually author mappings; a homeowner cannot build
  "KNX button 2 → Casambi light" through any UI today even though the backend already executes it.
- **Dependencies:** at least one real keypad driver (see above) should exist first — an editor with
  nothing real to bind to is premature, same reasoning already applied to the Automation Editor's
  onoff-only gap.
- **Complexity:** Large — needs its own scoped session/ADR.
- **Status:** Not started; fully documented as future work in ADR 0016.

### Finish the UI/UX Design Polish phase
- **Description:** The user-directed polish brief (Phase 2) is partially done — icon system and
  card/button/capability-chip polish shipped. Remaining: device-category ambient color identity
  (camera=blue-tech, media=cinematic, lighting=warm-gold, etc. — without conflicting with
  existing state-driven tinting), and layout-rhythm variation so each device category feels
  structurally distinct rather than reusing one hero→controls→more-controls shape everywhere.
- **Reason:** explicit, repeated user request — "not a CRUD app," compete visually with
  Control4/Savant/Crestron/Tesla/Sonos.
- **Dependencies:** none — builds on the now-complete icon/card/button work.
- **Complexity:** Large — touches every premium device page's composition, not just its colors.
- **Status:** Not started (blocked on user confirming direction before continuing, per the
  last session's handoff message).

### Infrastructure module (Premium Device Experience Library, remaining device types)
- **Description:** Build the remaining device types from the original 18-item priority list:
  Tesla/Vehicle (#11), Energy (#12), EV Charger (#13), Pool (#14), Irrigation (#15), Water Tank
  (#16), Generator (#17), Building Management (#18) — each needing Standard Card, Expanded
  Sheet, Premium Detail Page, capability mapper, and honest capability-gating per the "UI is the
  contract" principle already established for Media/Security.
- **Reason:** explicit original roadmap item; user paused it to prioritize the polish phase, not
  cancelled it.
- **Dependencies:** should wait for the polish phase (above) to land first, so new modules are
  built to the *new* premium standard instead of needing a second pass.
- **Complexity:** Large — 8 device types × full page set. Energy has real backend support
  (`services/analytics`, `/v1/energy/*`); the rest currently have little-to-no backend
  representation (KNX generic `onoff` for Pool/Irrigation; nothing for the rest) — expect most
  controls to be honestly capability-gated at first, same as Camera/NVR were.
- **Status:** Energy (device #1 of 8) built — see Completed. Solar, Battery Storage, EV Charger,
  Pool, Irrigation, Water Tank, Generator, Building Management, Vehicle not started; the new
  `features/infrastructure/<domain>/` pattern + `PowerRing` component are ready to extend.

### Finish emoji migration in generic device quick-sheets
- **Description:** `device-sheets.tsx`'s Climate/Fan/Vacuum/generic-Media quick-sheets still use
  emoji (heat/cool/fan-mode glyphs, shuffle/repeat icons) — out of scope for the Security/Media
  redesign pass but a loose end for "replace every emoji" (icon.tsx already has the pattern
  established, just needs ~6 more `PATHS` entries).
- **Reason:** consistency — the rest of the app no longer uses emoji.
- **Dependencies:** none.
- **Complexity:** Small.
- **Status:** Not started.

---

## Medium

### AVR renamed-input capability-config race condition
- **Description:** `AvrProtocolDriver.refreshInputEnrichment()` is called fire-and-forget (`void
  this.refreshInputEnrichment(...)`) at both `installer-context.ts:412` and
  `routes/devices.ts:291-299`, immediately followed by a synchronous `getCapabilityConfig()` read
  in the same code path. The HTTP AppCommand round-trip that populates renamed/hidden inputs
  hasn't resolved yet when that read happens, so the caller can observe stale (installer-declared
  default) input labels instead of the receiver's real renamed ones — narrow window, no data
  corruption, just a stale read.
- **Reason:** proven via a static, code-level audit (exact file/line citations above); not yet
  fixed, since the audit that found it was scoped to "identify only, propose the smallest fix,
  don't implement" and no follow-up session has picked it up yet.
- **Dependencies:** none.
- **Complexity:** Small — likely fixable by awaiting `refreshInputEnrichment()` before the
  read, or by having the read wait on the in-flight promise if one exists.
- **Status:** Diagnosed, not fixed.

### Wire real Redis/NATS backends behind the messaging seam
- **Description:** `services/messaging` uses in-process fakes for the event bus (NATS) and
  ephemeral/presence store (Redis) by default; real backends exist behind config but aren't
  verified end-to-end in a real multi-instance deployment.
- **Reason:** required for the hub to survive a process restart without losing live state /
  presence, and for horizontal scale-out.
- **Dependencies:** part of the production-readiness critical path.
- **Complexity:** Medium.
- **Status:** Scaffolded, not verified live.

### Cloud subscription sync + dealer portal
- **Description:** ADR 0014 explicitly notes cloud subscription sync and the dealer portal are
  scaffolded by the licensing provider model but not fully built.
- **Reason:** commercial model dependency — `cloud/dealer`/`cloud/subscription` need this to be
  usable by real installer organizations.
- **Dependencies:** `cloud/licensing`, `cloud/identity` (both further along).
- **Complexity:** Large.
- **Status:** Provider seam exists; sync/portal not implemented.

### Real CHIP/Thread Matter controller bring-up
- **Description:** Matter commissioning (setup-code parsing, commissioning seam, fabric manager,
  cloud multi-admin sync) is implemented in code, but the real `@matter/main` hardware
  controller bring-up is explicitly not runnable yet (ADR 0011).
- **Reason:** Matter support is a stated product feature ("optional and user-activatable").
- **Dependencies:** real Thread border-router hardware for testing.
- **Complexity:** Large.
- **Status:** Seam built, hardware integration outstanding.

### Real hap-nodejs HomeKit transport
- **Description:** the local HAP accessory bridge (`services/homekit`) has its mapping/bridge/
  routing logic done; the real `hap-nodejs` transport layer is the stated outstanding boundary
  (ADR 0012).
- **Reason:** Apple Home/Siri support is a stated product feature.
- **Dependencies:** none blocking, just unimplemented.
- **Complexity:** Medium.
- **Status:** Logic done, transport not wired.

### HEOS `queryPlayers()` unbounded discovery buffer
- **Description:** found during the AV SDK refactor's duplication audit: `heos-driver.ts`'s
  `queryPlayers()` (used only during `discover()`) reimplements manual `buffer.split("\r\n")` line
  accumulation instead of reusing the already-imported `LineAccumulator`, and — unlike
  `LineAccumulator` — has no `maxBytes` cap. A non-HEOS device answering on port 1255 with a flood
  of undelimited data during discovery could grow this buffer unbounded.
- **Reason:** real, low-risk, small-scope bug; adjacent to (but not part of) the AV SDK refactor's
  scope, so deliberately not silently bundled into any other change.
- **Dependencies:** none.
- **Complexity:** Small — reuse `LineAccumulator`, matching the pattern already used for AVR/HEOS's
  main TCP link buffers.
- **Status:** Not started.

---

## Low

### Live Playwright verification of the Casambi Driver Manager UI
- **Description:** the Casambi Driver Refactor session's new UI (`connectionType` Setup Wizard
  step, `CasambiLocalGatewayPanel`, `CasambiAdvancedPlaceholders`, `CasambiDiagnosticsPanel` in
  `apps/web-homeowner/src/drivers.tsx`) was typecheck/build/unit-test verified but never opened in
  a real browser — no running `hub-compose` stack/backend in that sandbox.
- **Reason:** this project's testing standard ("new UI behavior should be Playwright-verified
  live... not just typechecked") wasn't met, flagged honestly rather than claimed.
- **Dependencies:** `hub-compose` running (or the local dev server) with a Casambi driver
  installed.
- **Complexity:** Small — verification only, at all four required breakpoints.
- **Status:** Not started.

### Additional AVR brand drivers
- **Description:** `docs/architecture/adding-avr-brands.md` explicitly lists brands with zero
  implementation: Onkyo/Pioneer (ISCP/eISCP), Sony, Arcam, Anthem (ARC), NAD, JBL Synthesis,
  StormAudio, Trinnov.
- **Reason:** broaden AVR hardware compatibility beyond the current Denon/Marantz/HEOS/Yamaha
  set.
- **Dependencies:** the Universal AVR Framework (ADR 0015) already provides the seam; each brand
  is an isolated driver addition.
- **Complexity:** Medium per brand (protocol research + codec + tests).
- **Status:** Not started, framework ready.

### Live hardware verification of the Universal AV Driver SDK additions
- **Description:** Diagnostics Console, Room Assignment Engine, Automatic Zone Generation, and
  the Media Topology Engine (ADR 0015 addendum) were built and tested against in-process fake
  TCP/HTTP servers only — never against a real Denon/HEOS/Yamaha unit or a running `hub-compose`
  stack. The Topology UI has not been Playwright-verified at any responsive tier. A full,
  per-brand checklist now exists: `docs/architecture/avr-framework-production-audit.md` Phase 5
  — nothing on it is checked yet.
- **Reason:** this project's own testing standard ("new UI behavior should be Playwright-verified
  live... not just typechecked") wasn't met for this work — no backend/hardware was available in
  either session that built/hardened it. The production-readiness audit explicitly declines to
  call the framework production-ready until this is done (currently ~70%, see the audit's Phase
  10 report).
- **Dependencies:** `hub-compose` running, ideally real AVR hardware.
- **Complexity:** Small (verification only, no new code expected unless something's found).
- **Status:** Not started. One specific open question to resolve while doing this: does a bare
  Denon `Z2?` query echo Zone 2's current SOURCE as well as power on real hardware (the codec
  only sends `Z2?`/`Z2MU?` on reconnect, no explicit zone2-source query token)? **A concrete,
  written guided-capture procedure now exists** for the three RTI Capability Audit Category B
  items specifically (Zone 3/4, 8 extra channel-trim targets, Tone Defeat) —
  `RTI-Capability-Audit.md`'s closing section: with `devMode` on, send each probe token via the
  new Raw Command box and read the reply in the Protocol Trace panel. No code changes needed to
  run it, only physical access to a unit.

### Live Playwright verification of the Raw Command UI section
- **Description:** `RawCommandSection` (`device-detail-sections.tsx`, wired into
  `media/detail.tsx` as a devMode-gated sibling of Diagnostics/Protocol Trace) was built this
  session — typecheck/build clean, backed by a tested gateway route
  (`raw-command.e2e.test.ts`) — but never opened in a real browser.
- **Reason:** no running dev server/backend was available in this sandbox this session; per
  this project's UI verification standard, that's a real gap, not a completed item.
- **Dependencies:** `hub-compose` running (or the local dev server), an AVR device (real or the
  fake in-process test server) bound as native.
- **Complexity:** Small — verification only.
- **Status:** Not started.

### Wire `heartbeat()` into an automatic keepalive scheduler
- **Description:** `AvrProtocolDriver.heartbeat()` and `HeosProtocolDriver.heartbeat()` both
  exist, are tested, and return `{ ok, latencyMs }` — but nothing calls either one
  automatically. No scheduler, no interval, no gateway route, no UI affordance.
- **Reason:** flagged as "Partial" (not "✓") for the Keepalive Framework engine in
  `docs/architecture/Universal-AVR-SDK-Roadmap.md` — the primitive exists, the framework
  around it doesn't.
- **Dependencies:** none — both `heartbeat()` methods are ready to be called.
- **Complexity:** Small-Medium (interval scheduler + a health-degradation signal + surfacing it
  somewhere a user/installer can see it).
- **Status:** Not started.

### Raise Yamaha's real SDK-primitive reuse
- **Description:** `YamahaProtocolDriver` only adopted `state-cache.ts` from the AV SDK — it
  never migrated onto `HttpPollClient`/`AdaptivePoller` (built for and currently only used by
  AVR's HTTP AppCommand layer), and has no `heartbeat()`.
- **Reason:** documented honestly in `Universal-AVR-SDK-Roadmap.md`'s Yamaha mapping section as
  a concrete, scoped 3-step follow-up, deliberately not attempted this session (Yamaha's
  existing polling is working and tested; force-migrating "for consistency alone" was
  explicitly rejected as unjustified churn in the original SDK extraction pass).
- **Dependencies:** none.
- **Complexity:** Medium (migrate `getJson()`/`diagnosticsFor()`/`hostFeaturesInFlight` onto
  `HttpPollClient`; adopt `AdaptivePoller` for the existing zone-sync loop; add `heartbeat()`
  once a real Yamaha no-op-equivalent command is evidenced from official docs).
- **Status:** Not started.

### Legacy NetAudio now-playing metadata (Denon Cheat Sheet Audit bonus finding)
- **Description:** `docs/architecture/Denon-CheatSheet-Audit.md` found — while independently
  verifying the cheat sheet's claims, not from the cheat sheet itself — that `denonavr`'s source
  confirms a real, working now-playing metadata path (`formNetAudio_StatusXml.xml`'s `szLine`
  array) for its own legacy "NetAudio"-category sources (AirPlay, Media Server, iPod/USB,
  Bluetooth — a pre-HEOS streaming module, distinct from modern HEOS). This directly extends,
  not contradicts, `AVR-Universal-Capability-Matrix.md`'s existing "no verified source for
  non-HEOS inputs" finding, which was scoped to Tuner/USB checked against the 2016+
  `AppCommand.xml` path specifically.
- **Reason:** genuinely new, real, evidenced capability at the same evidentiary tier as the
  already-shipped `GetRenameSource`/`GetDeletedSource` (single independently-read OSS source,
  no official PDF, matching this project's own established bar for that kind of evidence) — but
  out of scope for a cheat-sheet audit pass and needs its own design decision (a second,
  legacy-only metadata source class feeding the existing Metadata Engine).
- **Dependencies:** none.
- **Complexity:** Medium (new parser in `avr-http-codec.ts`, a decision on how it composes with
  the existing HEOS-routed metadata path in `MediaCache`, tests).
- **Status:** Not started.

### Verify the pre-2016 legacy rename-list fallback on real hardware
- **Description:** `Denon-CheatSheet-Audit.md` classified the legacy full-zone-state snapshot's
  embedded partial input-rename list as "Needs Hardware Verification" rather than implementing
  it as an equal-confidence fallback to the already-shipped `GetRenameSource`/`GetDeletedSource`
  mechanism — both the cheat sheet's own text and `denonavr`'s source (which never uses it as a
  rename source either) flag it as incomplete.
- **Reason:** a real pre-2016 unit is needed to determine how incomplete it actually is in
  practice before ever surfacing it as installer-facing `device_reported` data.
- **Dependencies:** a real pre-2016 (port-80) Denon/Marantz receiver.
- **Complexity:** Small (verification only) — procedure is written in
  `Denon-CheatSheet-Audit.md`'s "Hardware verification tasks created" section: with `devMode` on,
  trigger a refresh/reconnect and compare the driver's `MainZoneStatus.input` read against the
  unit's real current input name.
- **Status:** Not started.

### An HTTP-request equivalent of the Raw Command devMode tool
- **Description:** The existing Raw Command escape hatch (`AvrProtocolDriver.sendRaw()`, §
  RTI Capability Audit Category C.4) only writes to the Telnet socket. There is no equivalent
  devMode tool for sending an arbitrary one-off HTTP request and inspecting the response.
- **Reason:** surfaced while trying to write a hardware-verification task for the Denon Cheat
  Sheet Audit's uncorroborated generic-keypress-endpoint finding — verifying it today requires a
  manual, out-of-band request (browser/`curl`) run by whoever has the hardware, since the
  in-app tooling doesn't cover it. Recorded honestly rather than silently worked around.
- **Dependencies:** none.
- **Complexity:** Small-Medium (mirrors the existing Raw Command route/UI shape — a devMode-gated
  method/route/UI-input triple — but for an HTTP GET/POST instead of a Telnet write).
- **Status:** Not started.

### Small, named gaps found by the Universal AV Driver SDK production audit
- **Description:** Three small, real, unaddressed gaps confirmed during the production-hardening
  audit (`docs/architecture/avr-framework-production-audit.md`, Phase 1/2/4/10): (1) Yamaha's
  `setEqualizer` (multi-band EQ) exists in the YXC spec but isn't wired into
  `yamaha-codec.ts`'s `commandToYamaha`; (2) HEOS's QuickSelect has a working command path
  (`heos-codec.ts:124`, `play_quickselect`) but `heosCapabilityConfig()` never populates
  `presets`/`advancedControls`, so there's no UI surface to trigger it; (3) HEOS's Bluetooth
  surface (if any) isn't modeled at all — `bluetooth` field always absent from
  `heosCapabilityConfig()`.
- **Reason:** found by direct code audit against the vendor specs, not guessed — each is a
  genuine, scoped, low-risk fix, not a design question.
- **Dependencies:** none.
- **Complexity:** Small, per item.
- **Status:** Not started; deliberately not fixed in the same session as the audit that found
  them, per that session's "no new features, harden only" scope.

### Fleet-wide missing `unbind()` on `INativeProtocolDriver`
- **Description:** confirmed during the AVR framework's Phase 6 stress-testing audit: no driver
  in the fleet implemented a way to remove ONE device's bindings without tearing down the whole
  driver via `disconnect()`.
- **Status:** ✅ **Done** — SupremeOS Driver Lifecycle Completion effort. `unbind?(deviceId):
  Promise<void>` added to `INativeProtocolDriver` and implemented on all 22 drivers in
  `@supreme/protocols` (including the 3 flagship AVR/HEOS/Yamaha drivers, which turned out to
  have no `unbind()` either despite the earlier audit's summary — corrected here, not assumed).
  Wired through `SupremeNativeAdapter.unbindDevice()` → `IBackendAdapter.unbindDevice?()` →
  `RoutingBackendAdapter` → `SupremeIntegrationLayer.unmapDevice()`, which previously only cleared
  SIL bookkeeping and never told the owning driver to release its own resources — that was the
  root cause. New `DriverLifecycleController` SDK primitive (20-state lifecycle + LIFO
  fault-tolerant cleanup registry) at `services/integration-layer/src/protocols/lifecycle.ts`.
  Five real leaks found and fixed along the way (AirPlay/AppleTV/Sonos `disconnect()` never
  cleaning up at all; Matter/KNX subscriptions with no unsubscribe mechanism; KNX's GA-scoped
  `unsubscribe()` risking killing a sibling device's subscription; an unbounded offline-command
  queue per unbound device; `SupremeNativeAdapter.connect()` not being idempotent, causing
  duplicate state events under a reconnect storm). Full detail: `docs/architecture/
  Driver-Lifecycle.md`, `Driver-SDK.md`, `Resource-Cleanup.md`, `Driver-Author-Guide.md`.

### Wire more protocols into the generic Room Assignment Engine
- **Description:** `services/commissioning/src/room-assignment-engine.ts` is protocol-agnostic
  (takes a generic `LocationHint`) but only AVR/HEOS/Yamaha discovery currently emits one. Matter
  (Room/Location cluster), KNX live discovery, Zigbee/Z-Wave/BLE could all feed it the same way.
- **Reason:** explicit product ask — "every SupremeOS driver should provide location hints."
- **Dependencies:** none — the engine itself needs no changes, only each driver's `discover()`.
- **Complexity:** Small per protocol.
- **Status:** Not started; deliberately deferred to avoid touching the working KNX ETS import
  pipeline and other stable discovery paths in the same session that built the engine.

### Whole-home Media Dashboard topology graph view
- **Description:** the Media Topology Engine currently renders only a per-device connections list
  (in the AVR console's sidebar); a whole-home graph view (the brief's worked example — "Living
  Room AVR ├── HDMI1 → Apple TV …") for the Media dashboard was not built.
- **Reason:** explicit brief ask ("support Diagnostics, Media Dashboard, Activity Generation,
  Automation Relationships") — only the diagnostics-adjacent per-device view shipped.
- **Dependencies:** `MediaTopology` schema (`packages/domain-model/src/media-topology.ts`) already
  exists and is populated by the per-device editor; a dashboard view just needs to read it.
- **Complexity:** Medium.
- **Status:** Not started.

### Bluetooth pairing management for HEOS/Yamaha
- **Description:** explicitly called out as out of scope for the current AVR framework.
- **Reason:** completeness of the AVR control surface.
- **Dependencies:** AVR framework.
- **Complexity:** Small–Medium.
- **Status:** Not started.

### Local (non-cloud-to-cloud) Alexa/Google fulfillment
- **Description:** current voice integrations are cloud-to-cloud only; a local fulfillment path
  was explicitly deferred to a follow-up.
- **Reason:** reduce cloud dependency for voice control, consistent with local-first principles.
- **Dependencies:** `cloud/voice`, local intent-routing design.
- **Complexity:** Large.
- **Status:** Deferred, not designed.

### Automation Editor: onoff-only field-resolution gap
- **Description:** confirmed during Automation Editor production hardening
  (`docs/architecture/Automation-Editor.md` §2): the automation DSL and engine
  (`packages/domain-model/src/automations-dsl.ts`, `services/automations/`) already support
  triggers/conditions/actions across every `CapabilityKind` (brightness/color/temperature/
  position/media/lock/fan/vacuum/sensor) and the full `CapabilityCommand` union — but both the web
  (`apps/web-homeowner/src/automations.tsx`) and mobile (`apps/mobile/lib/screens/
  automation_editor.dart`) drag-and-drop editors only ever author onoff-style device triggers/
  conditions/commands. A homeowner cannot build "when brightness drops below 20%, run a scene"
  through either builder today, even though the backend already executes it.
- **Reason:** a real, user-facing functionality gap, not a hardening concern — deliberately not
  fixed in the hardening pass that found it, per that pass's explicit "no new user-facing
  features" scope.
- **Dependencies:** the real, already-shared `getCapabilityConfig()` mechanism
  (`services/integration-layer/src/protocols/driver.ts`) is the natural foundation for a
  capability-aware field editor; see `docs/architecture/Automation-Editor-Future-Driver-SDK-
  Roadmap.md` for a fully-worked (but unimplemented) design proposal — Driver Command Metadata
  contract, maturity model, extension points — to build from rather than redesigning from scratch.
- **Complexity:** Large — needs its own scoped session/ADR (a generic, data-driven field-editor
  renderer for both platforms), not a bolt-on to another task.
- **Status:** Not started; fully documented as a future proposal, not implemented.

### `AutomationService` unit test coverage
- **Description:** `services/automations/src/service.ts` (the CRUD layer: create/update/remove/
  setEnabled/testRun) has no direct unit tests — its only coverage is one happy-path e2e test
  (`services/gateway/src/phase3.e2e.test.ts`, create + WSS-observed execution). Update/delete/
  enable-toggle/list/runs and validation-error paths are untested at the service level.
- **Reason:** found during the Automation Editor hardening pass's test-coverage audit; the engine
  itself (`engine.ts`) has solid coverage (8 tests), the CRUD wrapper around it does not.
- **Dependencies:** none.
- **Complexity:** Small — `InMemoryAutomationStore` already exists as an injectable fake, so this
  is straightforward unit testing, no new infrastructure needed.
- **Status:** Not started.

### `@supreme/web-homeowner` has no component-test infrastructure
- **Description:** confirmed during the Automation Editor hardening pass: the entire
  `apps/web-homeowner` app has zero `.test.tsx` files and no `@testing-library/react`/jsdom/
  happy-dom dependency — only plain-function `vitest` tests are possible today. This blocked
  adding real component/interaction tests (drag-and-drop, click handlers, save-payload
  correctness) for the Automation Editor; only its pure helper functions got new test coverage.
- **Reason:** a real, app-wide testing-infrastructure gap, not specific to automations — worth
  fixing once, deliberately, rather than every future UI hardening pass re-discovering it and
  settling for pure-function-only coverage.
- **Dependencies:** none — add `@testing-library/react` + `jsdom` (or `happy-dom`) as dev
  dependencies and a vitest environment config.
- **Complexity:** Small to set up; the follow-on value (actually writing component tests for
  `automations.tsx` and other pages) is separate, larger work.
- **Status:** Not started.

---

## Future ideas

- HRoT/TPM-backed hub identity ("future-ready," not yet built per the blueprint's Phase 4 notes).
- Multi-region cloud deployment (cloud roadmap plane C4).
- AI assistant expansion — energy/EV/solar hooks (cloud roadmap plane C4).
- A `CHANGELOG.md`/`ROADMAP.md` at the repo root — currently neither exists; roadmap detail
  lives only inside the two architecture blueprints. Worth extracting into a lighter-weight,
  more discoverable root file if the roadmap keeps changing.

---

## Completed

> High-level milestones only — see `git log` for full commit-level history, and
> `PROJECT_CONTEXT.md` §6 for what each milestone actually delivers.

- **`supreme-lan` LAN Transport Service — Phase 2 (Casambi Migration & Transport Monitor)** —
  migrated the Casambi Local Gateway driver completely onto `@supreme/lan`, using it as the
  reference implementation per the governing brief. `CasambiUdpSocketLike`/`CasambiUdpSocketFactory`
  deleted; `CasambiUdpEngine` now consumes the generic `UdpTransport` directly (no adapter layer,
  unlike KNX/mDNS/SSDP's Phase 1 shape) via a required `udpTransportFactory`. New
  `LocalDirectUdpTransport` (`@supreme/lan`) covers same-process dev/test (no NATS hop). Transport
  selection centralized once in `installer-context.ts`'s `nativeDriverContext()`
  (NATS-configured → `NatsUdpTransportClient`; otherwise → `LocalDirectUdpTransport`) — the Casambi
  Local Gateway driver now DEFAULTS through `@supreme/lan` in every environment, not just when
  explicitly opted in. New layered Transport Monitor (`getCasambiTransportMonitor()`,
  `GET /v1/drivers/:id/casambi/transport-monitor`) — Transport/NATS/Casambi Adapter/Driver
  sections, each backed by a real counter (new `decodedCount`/`decodeFailureCount`/
  `transportDiagnostics` on the UDP engine; new `packetsSent`/`packetsReceived`/`requestsSent`/
  `eventsReceived`/`lastError` on `NatsUdpTransportClient`; new `discoveryEventsCount`/
  `commandsIssuedCount`/`feedbackEventsCount` on the driver); new `queryLanHealth()` client helper
  calls the `supreme.lan.health` subject Phase 1 built server-side but nothing had called yet.
  Cloud implementation, entity model, discovery/event/command engines, and the Driver Manager UI
  are byte-for-byte unchanged (zero edits). New cross-package proof test
  (`casambi-over-supreme-lan.test.ts`, 7 tests) runs the REAL, unmodified `CasambiProtocolDriver`
  through its full connect/discover/feedback/command lifecycle over a REAL `NatsUdpTransportClient`
  + REAL `UdpTransportServer` sharing a REAL `IEventBus` (only the innermost `node:dgram` socket
  faked), including the honest failure path (unreachable `supreme-lan` → `connect()` rejects,
  never silently "succeeds"); new `casambi-lan-latency.test.ts` automated benchmark. Full monorepo
  `turbo run build typecheck test`: 173/173 tasks green, zero regression. **Real Docker validation
  (a real Docker Engine became available mid-session):** built the real `lan.Dockerfile` image,
  booted real `nats`+`lan` containers, and reproduced the actual bridge-vs-host broadcast bug for
  real — a genuine UDP broadcast was dropped by the bridge-networked container and received by the
  identical container on `docker-compose.lan-host.yml` + `docker-compose.nats-loopback.yml`.
  Found and fixed two real bugs in the process: `lan.Dockerfile` never copied `cloud`/`drivers`/
  `tools` (pnpm install failed outright); the `nats-loopback.yml` port publish was silently a
  no-op on an `internal: true`-only network (fixed with a second, non-internal, loopback-only
  network for `nats`). Measured a real ~8ms host-to-container round trip alongside the automated
  benchmark's sub-millisecond code-only numbers. **Still NOT done:** a real Lithernet gateway on a
  real physical LAN, and real Windows Docker Desktop — see the High-priority TODO item above and
  `docs/architecture/Supreme-LAN-Transport-Architecture.md` §10.3 for the exact scope of what
  remains outstanding before this is production-verified.
- **Production Architecture Refactor — `supreme-lan` LAN Transport Service (Phase 1)** — real
  hardware proved Docker bridge networking silently drops LAN broadcast/multicast (the Casambi
  Wireshark capture); moving the whole Gateway to host networking (tried previously) broke it
  instead (`getaddrinfo ENOTFOUND postgres`). Built a new, business-logic-free service
  (`@supreme/lan`, `services/lan`) that owns raw LAN sockets and talks to the unmodified Gateway
  only over the existing NATS event bus (`@supreme/messaging`, already deployed, zero new IPC
  invented). Generic `UdpTransport` interface (bind/send/joinMulticast/close +
  message/error/listening listeners) covers unicast, broadcast, and every multicast use in this
  codebase as presets, not separate transports. Four migration adapters
  (`services/protocols/src/lan-adapters/`) give Casambi/KNX-discovery/mDNS/SSDP a drop-in
  alternative to their existing real-`dgram` defaults — proven end-to-end (the real, unmodified,
  hardware-validated `CasambiUdpEngine` sending/receiving real packets entirely over the new
  transport) but deliberately NOT defaulted onto any driver yet. Docker: base compose gets a `lan`
  service (bridge, degraded-but-testable default); new `docker-compose.lan-host.yml` (host
  networking on Linux, mirrors the existing `docker-compose.appletv-host.yml` precedent) +
  `docker-compose.nats-loopback.yml` (NATS exposed on `127.0.0.1` only, since `supreme-core` is
  `internal: true`). 43 new tests across `@supreme/lan` and `@supreme/protocols`'s lan-adapters
  (fake-socket, `InProcessEventBus` contract/RPC, real-loopback UDP smoke test); zero regression
  across the full `@supreme/protocols` suite. Full detail:
  `docs/architecture/adr/0022-supreme-lan-transport-service.md`,
  `docs/architecture/Supreme-LAN-Transport-Architecture.md`, `SESSION_HANDOFF.md`.
- **AVR Diagnostic Mode** — after a static audit and a full runtime-instrumented pipeline trace
  (both against a fake AVR, since this environment has no access to real hardware) found no
  pipeline break, the user asked for a permanent, production-safe diagnostic facility installers
  can enable against their OWN real Denon/Marantz receiver and hand the resulting log back for
  analysis. Shipped: `SUPREME_AVR_DIAGNOSTICS` (off by default) — every real receiver event gets
  a correlation ID; every stage it passes through (TCP/Parser/patchMedia/emitFor/StateCache/
  Gateway/WebSocket) logs a tagged line; unrecognized lines capture hex/ascii/length/firstToken/
  sender/frequency (never a bare "unrecognized" message); exact session counters throughout;
  `GET /v1/devices/:id/diagnostics/export` streams the complete trace as a downloadable
  `diagnostic.log`. New `avr-diagnostics.ts` (`AvrDiagnosticsRecorder`, pure/no I/O, bounded
  buffers). Zero overhead when disabled (optional-chaining short-circuit, real JS/TS semantics).
  Correlation ID crosses the driver→gateway→WebSocket boundary via a new optional `traceId` field
  on `BackendStateEvent` and a new optional `INativeProtocolDriver.recordDiagnosticStage?()`
  method — no new cross-package coupling. No feature/protocol/parser changes — diagnostics only.
  13 new tests (recorder unit tests, driver wiring incl. a real unrecognized-line capture over
  real TCP, factory wiring, export-route e2e). Full monorepo build/typecheck/test green.
  `docs/architecture/AVR-Diagnostic-Mode.md` has the full enable/export walkthrough.
- **Casambi Driver Refactor (Foundation)** — restructured the working Casambi Cloud driver
  (unchanged behavior — same REST/WebSocket calls, same reconnect/heartbeat timing, same
  capability mapping) into a 10-module architecture (`services/protocols/src/casambi/`):
  Connection Manager, Cloud Transport, Local Transport (REST Client + UDP Engine — both
  architecture-only, every method honestly throws "not implemented yet"), Entity Mapper,
  Discovery Engine, Feedback Engine, an additive transport-independent Event Bus (`DeviceEvent`/
  `ButtonEvent`/`SceneEvent`/`SensorEvent`/`NetworkEvent`/`DiagnosticEvent`), a dedicated
  Diagnostics snapshot + Health Monitor framework, and Driver Settings. New Driver Store
  `connectionType` field (Cloud default/Local Gateway) plus new Local fields, a Setup Wizard step
  in the Driver Manager UI (Cloud shows the exact pre-existing fields unchanged; Local shows new
  fields + Auto Discover/Test Connection, both honest not-implemented-yet stubs), and a new
  Casambi Diagnostics panel. Zero Local REST/UDP protocol implementation, per the brief's explicit
  scope (that's PR-2/PR-3/PR-4/PR-5). Full monorepo `turbo run build typecheck test` green (113
  build/typecheck tasks, 97 test tasks), every pre-existing Casambi test passing unmodified. Not
  Playwright-verified live this session (no backend running in the sandbox). Full detail:
  `SESSION_HANDOFF.md`.
- **Casambi Driver Refactor — PR-2 Core Architecture + Local Gateway Foundation** — built the
  cross-driver SupremeOS Core (`services/protocols/src/core/`: Event Bus, Capability Engine,
  Packet Recorder Framework, Driver Health Engine, Driver Metrics Engine — none Casambi-specific)
  and implemented the REAL Casambi Local Gateway protocol, grounded byte-exact in the Lithernet
  UDP Developer Reference and WebAPI PDFs: a real `node:dgram` UDP Casambi Command engine
  (`local-transport/udp-codec.ts` + `udp-engine.ts`), the one documented REST write endpoint
  (`rest-client.ts`), NotifyControlValues-based progressive discovery (`local-discovery.ts`), a
  command mapper (`local-command-mapper.ts`), and `casambi-driver.ts` wired to all of it — Local
  mode now really connects, discovers, and controls onoff/brightness/color over UDP. Flagged (not
  silently resolved) three real documentation inconsistencies found in the reference PDFs. Cloud
  behavior untouched and re-verified. Full monorepo `turbo run build typecheck test` green (46/46
  tasks); `@supreme/protocols` alone: 67 test files, 644 tests, including ~120 new tests for this
  session's work. Honest, disclosed gaps carried to `TODO.md`: Local RGBW/CCT capability inference,
  `CoreEventBus` migration for the driver, Packet Recorder wiring, a Local reconnect loop, and real
  hardware verification. Full detail: `SESSION_HANDOFF.md`.
- **Casambi Architecture Validation & Refactor** — mandatory, honest pre-implementation audit of
  the whole driver against a required Connection Manager → Transport → Service → Command/Event/
  Discovery Engine hierarchy, per-layer, with no self-graded "yes" allowed. Found Command Engine
  and Event Engine did not exist as real entities — `command()` had an inline per-mode branch
  building/sending commands two ways, and two separate private methods (`onEvent`/`onLocalPacket`)
  each independently decided what a raw signal meant, duplicated once per transport. Discovery
  Engine was half-real (output-shaping genuinely shared; driving logic inline per transport).
  Refactored: new `command-engine.ts` (`CasambiCommandEngine` interface, `Cloud`/`LocalCommandEngine`
  implementations); `event-engine.ts` extended with a `CasambiSignal` union + `normalizeCloudEvent`/
  `normalizeLocalPacket`, collapsing the driver's two dispatch methods into one `applySignal`
  reaction; `discovery-engine.ts` extended with `startLocalDiscovery`/`stopLocalDiscovery`. Cloud's
  discovery-driving deliberately NOT forced into a shared interface (disclosed judgment call: two
  real callers with genuinely different pull-vs-push shapes, not evidence of a missing
  abstraction). Zero Cloud regression — the full pre-existing Cloud-mode test suite passed
  unmodified, verified after every incremental step. 25 new tests for the extracted engines. Full
  monorepo `turbo run build typecheck test` green (46/46 tasks; `@supreme/protocols`: 70 files, 669
  tests). Explicitly did NOT declare Casambi ready to be the standard template for future drivers —
  two disclosed gaps remain (`CoreEventBus` migration, `core/capability-engine.ts` consumption).
  Full detail: `docs/architecture/Casambi-Architecture-Audit.md`, `SESSION_HANDOFF.md`.
- **Casambi Local Gateway — Auth & UDP Diagnostics** — grounded in `Lithernet_General_Settings_
  Network.pdf`'s web-server-login section (p.64) and the UDP audit the brief required. Added
  `gatewayUsername`/`gatewayPassword` (independent of Cloud credentials) with HTTP Basic Auth sent
  on every Local REST request; `testConnection()`/`setTargetValue()` now distinguish
  unreachable/auth-failed/ok. Fixed a real, confirmed bug: the generic `validateDriverConfig`
  required Cloud AND Local fields unconditionally regardless of `connectionType` — fixed with a
  new, driver-agnostic `requiredIf` schema concept (domain-model), not a Casambi special case.
  Diagnosed and fixed the UDP "Unreachable" false-negative: the old Test Connection collapsed one
  timed-out probe reply into a boolean, a TCP-shaped assumption on a connectionless, push-based
  protocol; replaced with real, staged UDP instrumentation (`socketState`, local/remote
  address:port, packet counters, probe-only latency, last send/decode error — no fabricated packet
  loss, ever) surfaced both in a rewritten staged Test Connection response and in the ongoing
  Diagnostics snapshot. Zero Cloud regression. Full monorepo `turbo run build typecheck test`
  green (48/48 tasks); `@supreme/protocols` 71 files/690 tests, `@supreme/drivers` 22,
  `@supreme/gateway` 289, `@supreme/web-homeowner` 55 (build + typecheck also verified). Full
  detail: `docs/architecture/Casambi-Local-Auth-And-UDP-Diagnostics.md`, `SESSION_HANDOFF.md`.
- **Casambi Local Gateway — UDP Receive Pipeline Audit (real hardware capture)** — a real
  Wireshark capture (firmware 6.25) proved the gateway broadcasts to `255.255.255.255:10009`
  while SupremeOS reported `Packets Received = 0`. Confirmed via code audit: no reception-blocking
  filter/`connect()`/unicast-only logic existed; the real bug was `packetsReceived` only
  incrementing on successful decode, making "never arrived" and "arrived but failed to parse"
  indistinguishable. Fixed: the counter now increments before parsing, unconditionally; added
  `onRawDatagram()` (pre-parse proof of reception) and a bounded 20-entry real packet trace
  (raw ASCII/hex, source, decode result) surfaced in Driver Diagnostics and Test Connection. The
  report's exact byte sequence, reconstructed to its stated 99-byte length, is now a permanent
  regression fixture. Zero Cloud regression; full monorepo green. Full detail:
  `docs/architecture/Casambi-UDP-Receive-Pipeline-Audit.md`, `SESSION_HANDOFF.md`.
- **Denon Cheat Sheet Audit** — audited an installer/engineer cheat sheet ("Dan's Denon Cheat
  Sheets") against the official Denon Telnet protocol, the official HEOS CLI spec, and this
  project's own Universal AVR SDK, per the strict "reference only, never a source" hierarchy the
  user specified. Nothing from the cheat sheet's text/tables/examples/code was copied — every
  finding was independently re-derived by fetching and reading `denonavr`'s real source
  (MIT-licensed) and SupremeOS's own existing Telnet/AppCommand code, with citations pointing to
  those, never the cheat sheet. New `docs/architecture/Denon-CheatSheet-Audit.md`: a full
  per-capability table (official-protocol status / HEOS status / implemented / missing /
  hardware-verification-needed / recommendation / confidence), a gap matrix, and an SDK-layer
  placement review. Net result: most of the cheat sheet's write-path claims were already fully
  redundant with the already-shipped, universal Telnet control path; several things SupremeOS
  already does (renamed inputs, volume shown as dB) are independently confirmed to already be
  *better* than the cheat sheet's own described workflow; the one genuine, previously-silent gap
  it led to finding — pre-2016 Denon/Marantz units getting zero HTTP-sourced data (no album art,
  no renamed inputs) because the driver assumed every unit answered on port 8080 — was
  implemented: a new best-effort, cached-per-host `resolveHttpPort()`/`detectHttpGeneration()`
  probe (independently confirmed via `denonavr/foundation.py`'s own real `async_identify_
  receiver()`), a new legacy full-zone-state XML parser (`avr-http-codec.ts`'s
  `parseMainZoneStatus()`, used only for diagnostics, never as an equal-confidence rename
  source), and a fix so `getArtwork()` uses the detected port. An uncorroborated finding (a
  generic HTTP keypress-simulation endpoint) and an explicitly-unreliable one (HTML-scraping a
  SETUP page) were documented only, not implemented, per the stated evidence rules. A bonus
  finding unrelated to the cheat sheet itself (legacy `formNetAudio_StatusXml.xml` now-playing
  metadata for pre-HEOS NetAudio sources) was documented and recorded as a follow-up, not
  implemented this pass. Full monorepo `pnpm build`/`typecheck`/`test` green.
- **RTI Capability Audit, Phases 1–4** — executed the user's 4-phase instruction against the
  prior `RTI-Capability-Audit.md` A/B/C/D classification. Phase 1: all 5 Category A commands
  shipped (Subwoofer, Cinema/Music/Game/Pro Logic mode, Cinema EQ, Loudness Management, Tone
  Control On/Off — all official-PDF-cited). Phase 2: all 4 Category C application-layer patterns
  shipped — a new `InitHandshake` primitive (`av-sdk/init-handshake.ts`) for paced, response-
  driven init-sync plus a new `fullySynced` diagnostics field (C.1/C.2); `AvrProtocolDriver
  .heartbeat()` (C.3); a devMode-gated raw-command escape hatch threaded through 6 backend touch
  points to a new `POST /v1/devices/:id/raw-command` route plus a new `RawCommandSection` UI
  (C.4). Two real race-condition bugs were found and fixed via test-driven debugging while
  wiring this (a test-harness ECONNRESET gap, and a genuine `fullySynced` default-value race in
  `bind()`). Phase 3: an honest, non-fabricated response that this sandbox has no real Denon
  hardware to verify Category B against, plus a concrete guided-capture procedure using the new
  Raw Command + Protocol Trace tooling for someone with physical access to run themselves. Phase
  4: `docs/architecture/Universal-AVR-SDK-Roadmap.md` — an engine-level (not brand-level)
  roadmap across 17 engines, each cited against real code, plus a Denon/Yamaha/Anthem reuse
  mapping that deliberately corrects the user's own "reuses 95%" framing with real, measured
  numbers (Yamaha's actual SDK-primitive reuse is low) rather than repeating an unverified
  estimate. Full monorepo `pnpm build`/`typecheck`/`test` green.
- **Universal Intent & Capability Engine, Phase 2** (ADR 0017) — a protocol- AND
  device-independent semantic layer decoupling user interactions from drivers entirely:
  `AutomationAction` gained one additive `"intent"` variant (reused automatically by both the
  Automation Engine and the Phase 1 Keypad Mapping Engine — zero extra schema/engine work, the
  direct payoff of Phase 1's "reuse `AutomationAction` verbatim" decision); new
  `packages/domain-model/src/intents.ts` (`IntentDefinition`/`IntentTarget`); new
  `@supreme/intent-engine` service (`CapabilityIndex` — O(matching devices), never O(all devices),
  kept in sync via a new additive `HomeService.onDeviceChanged` event; `IntentRegistry` —
  extensible-forever catalog pairing serializable definitions with server-only `translate`/
  `runSystem` handlers, validated at registration; `registerBuiltinIntents` — 42 intents across
  lighting/climate/av/blinds/security/system, with `swingMode`/`tiltUp`/`tiltDown`/`executeScript`/
  `webhook` honestly registered-but-throwing where no real capability/infrastructure backs them
  yet; `IntentEngine` — the Capability Engine itself, 48 tests including a dedicated "migration
  readiness" proof). Full gateway REST wiring (`GET /v1/intents`, `POST /v1/intents/:id/run`, run
  history) + 11 e2e tests including a keypad mapping's intent action driving a real device through
  the same engine a direct REST call uses. Zero visual editor, zero new capability-model fields —
  explicitly Phase 2/architecture-only per the brief. Full monorepo `pnpm build`/`typecheck`/`test`
  green (56/56, 97/97, 97/97 tasks), every pre-existing suite passing unmodified. Full detail:
  `SESSION_HANDOFF.md`, ADR 0017, `docs/architecture/Universal-Intent-Capability-Engine.md`.
- **Universal Keypad Framework, Phase 1** (ADR 0016) — a protocol-independent input/feedback/
  mapping pipeline so any future keypad controls any Supreme device without a protocol-to-protocol
  mapping: Keypad Capability Model + 13 Universal Input Events + 11 Universal Feedback Commands +
  `KeypadSubscription`/`KeypadMapping` DSL (`packages/domain-model`); three new optional
  `INativeProtocolDriver`/`IBackendAdapter` members threaded through
  `SupremeNativeAdapter`/`RoutingBackendAdapter`/`SupremeIntegrationLayer`, proven via a synthetic
  extensibility test; new `@supreme/keypad-framework` service (`UniversalInputEngine` with
  short/long/double/triple-press + hold-start/holding/hold-end derivation,
  `UniversalFeedbackEngine` with capability-gated rendering, `SubscriptionManager`,
  `KeypadMappingEngine`/`Service` reusing the existing Automation DSL's conditions/actions verbatim,
  `expandVariables` for Optional Variables); full gateway REST CRUD wiring + e2e test. Zero real
  keypad driver, zero visual editor — explicitly Phase 1/architecture-only per the brief. Full
  monorepo `pnpm build`/`typecheck`/`test` green (55/55, 95/95, 95/95 tasks), every pre-existing
  suite passing unmodified. Full detail: `SESSION_HANDOFF.md`, ADR 0016, `docs/architecture/
  Universal-Keypad-Framework.md`, `Keypad-Driver-Author-Guide.md`.
- **Universal AV SDK refactor** (AVR/HEOS/Yamaha → thin protocol adapters) — a new internal-only
  `services/protocols/src/av-sdk/` module (`TcpLineTransport` + `state-cache.ts`'s
  `recordCapabilityState()`) extracting the real, evidence-backed duplication found by a prior
  architecture audit (a ~55-line TCP-link-pool + reconnect + line-buffering pattern between
  AVR/HEOS, plus a verbatim-identical `record()` in all three drivers). `AvrProtocolDriver`
  387→305 lines (~21%) and `HeosProtocolDriver` 522→437 lines (~16%) migrated onto
  `TcpLineTransport`; `YamahaProtocolDriver` 486→481 lines gets only the `record()` extraction
  ("thinner, not thin" — HTTP+UDP transport, no second caller in the fleet to justify a
  speculative HTTP-transport primitive). Zero placeholder adapters created for any of the 17
  unbuilt future brands — instead, a synthetic `extensibility.test.ts` proves the SDK's public API
  is sufficient for a from-scratch adapter, backed by a new `AV-Adapter-Development-Guide.md`. All
  pre-existing driver test suites (AVR 19, HEOS 21, Yamaha 24 tests) pass **unmodified** — the
  regression evidence that runtime/protocol/discovery/diagnostics/reconnect behavior is unchanged.
  Full monorepo `pnpm build`/`typecheck`/`test` green (54/54, 93/93, all tasks). New
  `docs/architecture/Universal-AV-SDK.md` + `AV-Adapter-Development-Guide.md`; updated
  `avr-sdk-developer-guide.md` to correct its stale "no separate AVR engine" claim. Full detail:
  `SESSION_HANDOFF.md` Part 4.
- **Universal AV Driver SDK production hardening audit** — full 10-phase audit
  (`docs/architecture/avr-framework-production-audit.md`): architecture/digital-twin/
  lifecycle audit, protocol coverage matrix, hardware validation checklist (unchecked,
  honest), stress-testing, performance audit, production readiness report (~70%,
  explicitly not marked production-ready — see the report for why). Found and fixed
  two real concurrency bugs (a TOCTOU race + orphaned-timer leak in
  `YamahaProtocolDriver.ensureHostFeatures()`, and unbounded overlapping HTTP requests
  in `syncZone()`, both fixed via in-flight-promise coalescing), one real resource-
  safety gap (no upper bound on `link.buffer` in AVR/HEOS — a misbehaving device could
  grow memory without limit; fixed with a new shared, bounded `LineAccumulator`
  (`line-buffer.ts`), which also deduplicated identical buffer-handling code that was
  previously copy-pasted between the two drivers), and one lifecycle gap (`command()`
  never checked whether the driver had been `disconnect()`-ed, silently resurrecting a
  real connection instead of failing — now guarded in all 3 drivers). 15 new tests, all
  348 protocol-package tests and all 93 monorepo build/typecheck/test tasks pass. New
  developer docs: `docs/architecture/avr-sdk-developer-guide.md` (SDK/Lifecycle/Digital
  Twin/Discovery/Capability/Diagnostics/Room-Assignment/Topology reference) and a new
  §8 in `adding-avr-brands.md` confirming all 9 future brands (Anthem/Arcam/NAD/Sony/
  Pioneer/Onkyo/JBL Synthesis/StormAudio/Trinnov) are supported without architectural
  change. Three small named gaps and one fleet-wide architectural gap were found and
  deliberately NOT fixed (out of "harden, don't add features" scope) — see the new TODO
  items above.
- **Universal AV Driver SDK completion** (ADR 0015 addendum) — Diagnostics Console
  (`services/protocols/src/driver-diagnostics.ts`, wired into AVR/HEOS/Yamaha drivers, exposed
  via a new `INativeProtocolDriver.getDiagnostics?()` seam and `GET /v1/devices/:id/diagnostics`);
  a generic, protocol-agnostic confidence-based Room Assignment Engine
  (`services/commissioning/src/room-assignment-engine.ts`, explicitly superseding ADR 0015 §2.3's
  narrower "installer always assigns the room" position); Automatic Zone Generation for Yamaha's
  real multi-zone units (`InstallerServices.autoCommissionMedia`, `POST /v1/commissioning/
  auto-media`); a Media Topology Engine (`packages/domain-model/src/media-topology.ts`,
  installer-declared HDMI/zone graph, editable in the AVR console). Also fixed a pre-existing gap
  where `RoutingBackendAdapter` never implemented `getCapabilityConfig`. See `SESSION_HANDOFF.md`
  and the ADR addendum for full detail; not yet live-verified against real hardware.
- Infrastructure module, Energy (device #1 of 8) — `features/infrastructure/energy/`
  (capability-mapper/card/detail) plus `infrastructure-energy.tsx` (whole-home dashboard),
  replacing the old plain-`.card.row` Energy tab. New shared `PowerRing` radial-gauge component
  in `@supreme/aureon-web`, 7 new icons (`plug`/`sun`/`ev`/`generator-unit`/`leaf`/`trend-up`/
  `flow`). Whole-home hero and per-device consumption sparkline both read real
  `client.energySummary()`/`/v1/energy/history` data — no fabricated live numbers; per-device
  page gates Schedule/Load Priority/Usage Alerts/Efficiency Insights honestly (no backing
  capability exists yet). `devices.tsx`'s `friendlyType()` updated to classify energy devices.
- Monorepo foundation: pnpm + Turborepo (TS/Python) + Melos (Flutter), domain-model, contracts,
  Aureon design tokens, hub Compose stack with hidden HA, SIL skeleton, Identity + Permissions,
  gateway (REST + WSS).
- Homeowner MVP: Dashboard, Rooms, Device Control, Scenes, Favorites, Notifications, user
  management/roles, local + remote access.
- Installer Portal, Driver Store, device discovery/commissioning (KNX/DALI/Casambi/Matter/MQTT/
  Modbus), diagnostics, backup/restore, licensing.
- KNX ETS import engine (full `.knxproj`/`.esf` parsing, device recognition, room assignment,
  learning engine, review-before-commit UI on web + mobile).
- Universal AVR/media framework — AVR (Denon/Marantz Telnet), HEOS, Yamaha MusicCast drivers;
  rich AVR console UI (album art, halo/particle ambient glow, volume knob, waveform) on web +
  Flutter; real SSDP/mDNS discovery.
- Design System phases 0–8: `@supreme/aureon-web` component library (Button, Card, Chip/Badge,
  Sheet, unified Icon registry, responsive breakpoints), migrated every existing device console
  onto it, Universal DeviceSheet 7-section architecture (Information/Diagnostics/Automations/
  History/Advanced Settings + capability-specific Overview/Controls).
- Responsive framework (frozen): density engine (compact/comfortable/expanded), fluid tokens,
  Grid/Container/Stack primitives.
- **Premium Device Experience Library — Media module:** feature-module architecture
  established; Television/Projector/AVR/Speaker with capability-driven classification and the
  "UI is the contract" gating principle.
- **Premium Device Experience Library — Security module:** Door Lock, Furniture Lock, SIP Video
  Door Phone, Camera, NVR, Alarm System — full premium pages, all wired into the Security tab.
- **UI/UX Design Polish phase (first pass):** shared Card/Button/QuickActions/CapabilityGrid
  primitives upgraded with real depth, motion, and a decluttered capability-gating presentation;
  complete SVG icon system (63 icons) replacing emoji across Security + Media; fixed an app-wide
  ultrawide-display layout bug.
- Project memory system established: `CLAUDE.md`, `PROJECT_CONTEXT.md`, `SESSION_HANDOFF.md`,
  `TODO.md` (this file).
