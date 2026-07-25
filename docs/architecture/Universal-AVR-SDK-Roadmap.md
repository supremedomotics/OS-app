# Universal AVR SDK — Roadmap

> Not a Denon document. Not an RTI document. This is the roadmap for the **SDK** —
> `services/protocols/src/av-sdk/` plus the shared engines/patterns each brand driver
> (`avr-driver.ts`, `yamaha-driver.ts`, `heos-driver.ts`, and any future brand) draws
> from. Every status below is read off real code and real tests in this repository as
> of this pass, not aspirational — see the citation after each line. Companion
> documents: [Universal-AV-SDK.md](./Universal-AV-SDK.md) (the extracted-module
> architecture), [AVR-Universal-Capability-Matrix.md](./AVR-Universal-Capability-Matrix.md)
> (per-capability wire evidence), [RTI-Capability-Audit.md](./RTI-Capability-Audit.md)
> (the A/B/C/D evidence classification this pass's Category A/C work came from).

## Why this document exists

Every prior AV SDK document in this repo is scoped to *what was extracted* or *what one
brand's driver does*. None of them answer "if I'm building the 4th, 5th, 6th AVR brand
driver, what do I get for free, what do I have to build myself, and in what order should
the SDK itself grow?" That's what this document is for. It will be revisited every time a
new brand driver ships or a Planned/Partial engine below is promoted — this is a living
roadmap, not a one-time snapshot.

## The engine roster

```
Universal AVR SDK

Core Transport
    ✓

Realtime Event Engine
    ✓

Diagnostics
    ✓

Capability Engine
    ✓

Protocol Recorder
    Partial

Connection State Machine
    Partial

Keepalive Framework
    Partial

Zone Engine
    ✓ (per-driver, not unified — see note)

Media Engine
    ✓

Artwork Engine
    ✓

Metadata Engine
    Partial

Audio Processing Engine
    ✓

Video Processing Engine
    Partial

Calibration Engine
    Planned

Developer Console
    Partial

Capability Discovery
    Partial

Hardware Verification Mode
    Planned
```

### What each status means and is backed by

| Engine | Status | Real code / evidence | Why this status, not a higher or lower one |
|---|---|---|---|
| **Core Transport** | ✓ | `av-sdk/tcp-line-transport.ts` (`TcpLineTransport`, pooled/reconnecting/line-buffered TCP — shared by AVR + HEOS), `av-sdk/http-poll-client.ts` (`HttpPollClient` + `AdaptivePoller`, shared in-flight-deduped HTTP + adaptive polling) | Both real transport shapes seen across the current 3-driver AV fleet (persistent-socket line-protocol, and request/response HTTP) have a shared, tested primitive. A genuinely novel transport shape (e.g. binary/websocket) would still need its own primitive — not a gap, just unencountered yet. |
| **Realtime Event Engine** | ✓ | `TcpLineTransport`'s `onLine` hook dispatch, `recordCapabilityState()` (`av-sdk/state-cache.ts`) fan-out to `StateListener`s, HEOS's `register_for_change_events`, Yamaha's UDP event listener | Push-based state delivery is real and tested for all three drivers; the dedupe-and-notify core (`recordCapabilityState`) is 100% shared code, not per-driver reimplementation. |
| **Diagnostics** | ✓ | `driver-diagnostics.ts` (`DriverDiagnosticsTracker`) — connection status, packet counters, rolling `averageLatencyMs`, 200-line trace ring buffer (`recordTrace`/`recentTrace`); surfaced via `GET /v1/devices/:id/diagnostics` and `GET /v1/devices/:id/diagnostics/trace` | One shared tracker class, called automatically by every driver on every send/receive regardless of transport (Telnet, HTTP, UDP) — the fullest example of a truly universal engine in this SDK today. |
| **Capability Engine** | ✓ | `avr-capabilities.ts` (`AudioCapabilityConfig`, `source: "device_reported" \| "installer_declared"`), `denonCapabilityConfig()`/Yamaha/HEOS equivalents, `CapabilityGate`/`CapabilityGrid` (`features/_shared/capability-availability.ts`) rendering only real, backed controls | The "UI is the contract" pattern (never fabricate a live control) is enforced identically for every brand driver through one shared gating primitive on the frontend and one config shape on the backend. |
| **Protocol Recorder** | Partial | `DriverDiagnosticsTracker.recordSend`/`recordReceive` timestamp every raw token on every transport automatically; the trace ring buffer already captures Telnet **and** HTTP AppCommand traffic for the same device side-by-side, in arrival order (§ `Universal-AV-SDK.md`, "Universal Protocol Discovery Framework") | What's real: per-device, per-transport timestamped capture. What's missing: no cross-protocol **correlation** (matching a Telnet event to its HTTP-side echo by time/cause), and SSDP/UPnP GENA/HEOS traffic aren't merged into the same buffer as a bound AVR device's. Not "Planned" because real capture already ships; not "✓" because correlation doesn't exist. |
| **Connection State Machine** | Partial | This pass: `DriverDiagnosticsSnapshot.fullySynced: boolean` + `av-sdk/init-handshake.ts`'s `InitHandshake` class (paced, response-driven init-burst draining) — reproduces RTI's own "Starting Up → Initializing → Connected" transition as a boolean gate on top of the existing 3-state `connectionStatus` (`connected`/`connecting`/`disconnected`) | A genuine connection-readiness signal exists and is tested (`avr-driver.test.ts`'s "fullySynced becomes true once the paced init-sync handshake fully drains" case) — that's real progress, not vaporware. What's NOT built: RTI's full 4-state enum as a first-class type (SupremeOS models it as `connectionStatus` × `fullySynced` — two orthogonal booleans/enums, not one 4-value state machine type), and HEOS/Yamaha haven't adopted `InitHandshake` yet (only AVR has). |
| **Keepalive Framework** | Partial | `AvrProtocolDriver.heartbeat()` (this pass, `PW?` probe) and `HeosProtocolDriver.heartbeat()` (prior pass, `system/heart_beat`) both exist, tested, `{ ok, latencyMs }` shape | Real, callable, on-demand liveness probes exist for 2 of 3 drivers (Yamaha has none — it's HTTP request/response with no persistent connection to keep alive, so a heartbeat concept doesn't obviously map the same way). Neither AVR's nor HEOS's `heartbeat()` is wired into any scheduler or gateway route yet — nothing calls either one automatically today. "Framework" implies an automatic, scheduled keepalive loop with configurable intervals and a health-degradation signal; only the manually-callable primitive exists. |
| **Zone Engine** | ✓ (per-driver, not unified) | AVR: installer-declared 2-zone enum (`"main" \| "zone2"`), no wire detection. Yamaha: wire-discovered 4-zone enum via a real `getFeatures` HTTP query. HEOS: no zone concept at all — an opaque `pid` string per player. | Marked ✓ because every driver that needs zone modeling has a real, working one — but `Universal-AV-SDK.md` explicitly documents that a **unified** `ZoneEngine` type was considered and rejected: the three models are incompatible enough (installer-declared vs. wire-discovered vs. no-concept-at-all) that forcing one shared type would be a false abstraction, not a consolidation. This is a deliberate design decision, not a gap. |
| **Media Engine** | ✓ | Per-driver `MediaState`/`buildMediaState()` (AVR), Yamaha/HEOS equivalents; `MediaTopology` (`packages/domain-model/src/media-topology.ts`) for installer-editable HDMI/zone graphs | Play/pause/source-select/volume state is fully modeled and pushed in realtime for every driver in the fleet today. |
| **Artwork Engine** | ✓ | `ArtworkCache` (`services/gateway/src/artwork-cache.ts`, LRU+TTL) fed by each driver's `getArtwork()` — AVR proxies `/img/album%20art_S.png` (confirmed-static URL, this pass's predecessor), HEOS passes a remote URL through, both behind the same `GET /v1/devices/:id/media/artwork` route. **§ Denon Cheat Sheet Audit**: now genuinely works on pre-2016 Denon/Marantz units too — the fetch previously assumed a fixed port 8080 (silently failing on older units), now uses the driver's auto-detected HTTP generation/port. | One shared cache, two real producer patterns, both wired and tested — genuinely universal at the gateway layer even though each driver's fetch is brand-specific by necessity. |
| **Metadata Engine** | Partial | HEOS `player/get_now_playing_media` — real, tested, full title/artist/album. Denon/Marantz: **only** available for HEOS-routed content on the sibling HEOS device; confirmed via direct source reads (`denonavr`, and a dedicated XML-dump tool by the same author) that **no** endpoint parses title/artist/album for Tuner/USB/non-HEOS Denon inputs — this is a confirmed absence, not an under-researched gap (`AVR-Universal-Capability-Matrix.md` §"Now-Playing Metadata") | Genuinely ✓ for HEOS/Yamaha-sourced content, genuinely and permanently unavailable for a large slice of Denon/Marantz's own inputs on current evidence. "Partial" is the honest label for an engine whose completeness depends on which brand/input you ask about, not a single yes/no. |
| **Audio Processing Engine** | ✓ | This pass: Subwoofer On/Off, Cinema/Music/Game/Pro Logic mode, Cinema EQ, Loudness Management, Tone Control On/Off (`RTI-Capability-Audit.md` Category A, all 5). Prior pass: Dynamic EQ, Audyssey MultEQ mode, Reference Level Offset, Dynamic Volume, DRC (all official-PDF-cited, `PS`-prefixed Telnet enums) | Every command in this engine traces to an official protocol document with an exact, literal token — none guessed. Channel-level trims (`CV<ch> <nn>`) are encoded and evidenced but have no range-slider UI yet (tracked in the capability matrix, not silently dropped) — that's a UI gap, not an engine gap, hence still ✓ for the engine itself. |
| **Video Processing Engine** | Partial | `advanced.audioFormat`/`sampleRateKHz`/`bitDepth` badges already render in `media/detail.tsx` **if** populated — no driver populates them (no verified response schema found for any brand this session). Video-output routing (scaling/aspect/resolution/HDMI-audio-routing) is Category D.4 in `RTI-Capability-Audit.md` — RTI-only evidence, no official corroboration found in this project's evidence set. | The UI slot exists and is dormant, not missing; the wire evidence to populate it doesn't exist yet for any brand. Stays Partial (not Planned) because the display path is real and tested even though nothing feeds it. |
| **Calibration Engine** | Planned | Audyssey **mode selection** exists (a fixed enum: off/MultEQ/MultEQ XT/MultEQ XT32 etc., official-PDF-cited) — but no guided measurement/calibration **workflow** (position-by-position mic sweep, auto-EQ curve generation) exists anywhere in this codebase, for any brand, and no protocol evidence for driving one has been gathered | A calibration mode toggle is not a calibration engine — the workflow concept doesn't exist yet even in design form. Correctly Planned, not Partial. |
| **Developer Console** | Partial | `DiagnosticsSection`, `ProtocolTraceSection`, and this pass's `RawCommandSection` (all devMode-gated, `apps/web-homeowner/src/device-detail-sections.tsx`) — diagnostics fields, a live trace log, and now a raw-token escape hatch, all per-device | Real, tested, devMode-only tooling exists and is genuinely useful for driver development/field diagnosis — but it's three sections bolted onto the normal device detail page, not a dedicated console/dashboard with its own navigation, cross-device view, or command history. "Partial" reflects that the *capability* is there, the *product surface* isn't yet. |
| **Capability Discovery** | Partial | Each driver's `discover()` does real, brand-specific enrichment: AVR's SSDP+UPnP-description + AppCommand rename/hidden-input fetch, Yamaha's `getHostZones()`, HEOS's SSDP. `discoverWithStatus()` (`SupremeNativeAdapter`) gives protocol-filtered, per-driver-failure-isolated results. **§ Denon Cheat Sheet Audit**: AVR's discovery now also auto-detects the unit's HTTP generation (2016+ vs. legacy) before attempting enrichment, so it no longer wastes a request on a doomed `AppCommand.xml` call for older units. | Real, working, per-driver discovery exists and is wired into the guided commissioning wizard. What's missing for "✓": no cross-protocol dedup (the same physical unit answering both SSDP-AVR and SSDP-HEOS isn't merged into one discovery candidate today), and no generalized "probe this IP across every registered brand driver" sweep — each brand's probe (`avr-probe.ts`, `yamaha-probe.ts`) is invoked individually by the wizard, not automatically fanned out. |
| **Hardware Verification Mode** | Planned | This pass's `RTI-Capability-Audit.md` addendum documents a **manual** guided-capture procedure (send a probe token via Raw Command, read the reply in Protocol Trace, report it back) — real and usable today, but it's a human following written steps, not software | `Universal-AV-SDK.md`'s own "Universal Protocol Discovery Framework" section already lays out precisely what a real, automated Hardware Verification Mode needs (extend the trace buffer to more transports, add a start/stop capture window, a timestamp-keyed diff pass, a UI prompt/timer) and states plainly why it wasn't built: it requires real hardware in the loop to validate correlation logic against, which this sandboxed environment does not have. Correctly Planned, with a concrete, non-speculative spec already written down for whoever builds it next. |

## Mapping: Denon/Marantz (the reference implementation)

```
Denon
↓
Uses:
  Core Transport            (TcpLineTransport — Telnet; HttpPollClient — AppCommand)
  Realtime Event Engine     (Telnet push via onLine dispatch)
  Diagnostics               (full — including the new averageLatencyMs + trace ring buffer)
  Capability Engine         (denonCapabilityConfig(), installer-declared + device-reported)
  Protocol Recorder         (Partial — Telnet+HTTP trace buffer; no correlation)
  Connection State Machine  (Partial — fullySynced boolean via InitHandshake, this pass)
  Keepalive Framework       (Partial — heartbeat() exists, unscheduled)
  Zone Engine               (installer-declared 2-zone: main/zone2)
  Media Engine              (full)
  Artwork Engine            (full — static album-art URL proxy, now generation-aware)
  Metadata Engine           (Partial — HEOS-routed content only, confirmed absent elsewhere)
  Audio Processing Engine   (full — 10 confirmed PS-family commands this + prior pass)
  Video Processing Engine   (Partial — UI slot dormant, no evidence)
  Developer Console         (full — Diagnostics + Protocol Trace + Raw Command, this pass)
  Capability Discovery      (Partial — SSDP/UPnP + AppCommand enrichment, now generation-aware, no cross-protocol dedup)
```

§ Denon Cheat Sheet Audit (see `Denon-CheatSheet-Audit.md`) added one real capability to this
mapping: a receiver-generation/HTTP-port auto-detector (`resolveHttpPort()`), independently
confirmed via `denonavr`'s own real source, not from the cheat sheet itself. It closed a
previously-silent gap where pre-2016 Denon/Marantz units got zero HTTP-sourced data (no album
art, no renamed inputs) because the driver assumed every unit was on port 8080. Every other
capability the cheat sheet raised was either already implemented and independently confirmed to
already be *better* than the cheat sheet's own described workflow (renamed inputs, volume-as-dB
UI), fully redundant with the already-shipped, universal Telnet control path (every write
command it describes), or left undocumented/unimplemented for lack of independent corroboration
(the generic keypress endpoint, the HTML-scraped rename page) — none of that required a change
to this roadmap's engine statuses.

Denon/Marantz is the SDK's reference implementation specifically **because** it's the only
driver in the fleet that exercises two transports (Telnet + HTTP) through the SDK's shared
primitives simultaneously — every future TCP-line-protocol OR HTTP-poll-style brand can
follow either half of this driver as a template, not just the whole thing.

## Mapping: Yamaha (an existing driver — honest reuse, not a placeholder number)

```
Yamaha
↓
Reuses:
  Diagnostics    — full (DriverDiagnosticsTracker, same class, called directly)
  Realtime Event Engine — the dedupe/notify core (recordCapabilityState) — same function
Does NOT reuse (yet):
  Core Transport (TcpLineTransport / HttpPollClient / AdaptivePoller)
  Connection State Machine (InitHandshake)
  Keepalive Framework (no heartbeat())
```

This is a deliberate correction, not an oversight: **Yamaha's real, measured reuse is far
below a headline "95%."** `Universal-AV-SDK.md`'s own before/after table records it plainly —
`yamaha-driver.ts` shrank ~1% when the SDK was extracted (486 → 481 lines), because it only
adopted `state-cache.ts`. It keeps 100% of its own HTTP request/response bookkeeping,
in-flight-coalescing maps, and UDP event parsing, because — as documented at the time —
`TcpLineTransport` genuinely doesn't apply to a driver with no persistent per-host socket,
and force-migrating Yamaha onto `HttpPollClient`/`AdaptivePoller` "for consistency alone"
was explicitly rejected as unjustified churn against a working, tested driver.

**What would actually raise Yamaha's reuse, concretely, if pursued as a follow-up:**
1. Migrate its `getJson()`/`diagnosticsFor()`/`hostFeaturesInFlight` pattern onto
   `HttpPollClient` (documented in `Universal-AV-SDK.md` as "a real, recommended, separate
   follow-up," not attempted this pass) — this alone would likely be the largest single jump,
   since it's the same shape Yamaha already hand-rolled.
2. Adopt `AdaptivePoller` for its existing zone-sync polling loop, replacing whatever
   fixed-interval logic it uses today.
3. Add a `heartbeat()` using Yamaha's own no-op-equivalent query (needs a real command
   evidenced from Yamaha's official API docs first — not guessed).

None of this is blocked architecturally; it simply wasn't in scope for this pass, which
focused on Denon/Marantz per the user's Category A/B/C/D audit. Recorded here as the
concrete next roadmap item for Yamaha specifically.

## Mapping: Anthem (not yet built — a projection, not a driver)

```
Anthem
↓
Not yet built. Projected reuse based on Phase 9 readiness findings:
  Core Transport            — High confidence: Anthem ARC is TCP/Telnet-style,
                               matching avr-driver.ts's TcpLineTransport shape directly
                               (docs/architecture/avr-framework-production-audit.md, Phase 9)
  Realtime Event Engine     — High confidence: same onLine-dispatch pattern applies
  Diagnostics               — High confidence: DriverDiagnosticsTracker is transport-agnostic
  Connection State Machine  — High confidence: InitHandshake is protocol-agnostic by design
  Keepalive Framework       — High confidence: same heartbeat() shape, needs Anthem's own
                               no-op-equivalent probe command evidenced first
  Capability Engine         — Structural shape reusable; the actual command vocabulary
                               (Audio/Video Processing Engine content) is 100% unevidenced —
                               zero Anthem commands have been sourced from an official
                               protocol document in this project to date
```

**No driver file exists for Anthem.** Phase 9 (`avr-framework-production-audit.md`)
verified the *architecture* accommodates it without a framework change — a real, useful
finding — but that is not the same claim as "Anthem is ready to reuse 95% of the SDK,"
and this document will not repeat that overstatement. The honest projection: everything in
the **transport/diagnostics/connection-management** tier (Core Transport, Realtime Event
Engine, Diagnostics, Connection State Machine, Keepalive Framework) is likely to be a
near-total reuse the day someone builds `anthem-driver.ts`, because those engines are
already protocol-agnostic by construction. Everything in the **command vocabulary** tier
(Capability Engine's actual contents, Audio Processing Engine, Video Processing Engine) is
100% new evidence-gathering work — the same official-PDF-or-independent-source discipline
this session applied to every Denon command, with zero shortcuts, because guessing an
Anthem `SetChannelLevel`-equivalent command is exactly the class of risk this project's
"never guess a wire command" rule exists to prevent.

## Roadmap ordering (what promotes what, and in what order)

1. **Now → next**: promote Category B items (`RTI-Capability-Audit.md`) from Medium to
   High confidence via the guided manual-capture procedure documented this pass (Raw
   Command + Protocol Trace) — the only blocker is someone with physical Denon/Marantz
   hardware running the 3-step probe already written down. Zero new engineering.
2. **Protocol Recorder → ✓**: build the correlation pass over the existing trace buffer
   (a timestamp-keyed diff across transports) — no new capture infrastructure needed,
   purely an analysis layer over data already being collected.
3. **Keepalive Framework → ✓**: wire the two existing `heartbeat()` methods into an
   actual scheduler (interval + health-degradation signal) and a gateway route/UI
   affordance — the primitives exist, only the automation layer is missing.
4. **Connection State Machine → ✓**: extend `fullySynced: boolean` into RTI's full
   4-state shape if a concrete product need for the finer granularity emerges; not
   urgent, since the boolean already answers the one question drivers currently need
   ("is this device fully synced or not").
5. **Yamaha reuse → raised**: the 3-step migration path above (`HttpPollClient`,
   `AdaptivePoller`, `heartbeat()`), independently valuable regardless of any future
   brand work.
6. **A 4th brand driver (Anthem or otherwise) → built**: only once its own command
   vocabulary is evidenced from an official source or a cross-checked independent
   implementation — never before, per this project's standing evidence discipline.
7. **Hardware Verification Mode → built**: only once real hardware is available to
   validate the correlation logic against, per `Universal-AV-SDK.md`'s own stated
   blocker — the spec is already written, this is purely an environmental gate, not
   an engineering unknown.
