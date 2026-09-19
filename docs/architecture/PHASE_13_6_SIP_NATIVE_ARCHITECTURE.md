# Phase 13.6 — SIP Native Architecture

Describes the native SIP implementation this phase designs and partially builds (the Dart-facing
half — see the final report for exactly what is REAL vs. designed-but-unbuilt). Builds on
[PHASE_13_5_SIP_ARCHITECTURE.md](PHASE_13_5_SIP_ARCHITECTURE.md); read that first for the
`SipService`/`SipEngine`/domain-model layer, which this document does not repeat.

## Native architecture

```
SupremeOS (Dart)
    │
    ▼
SipService                         (apps/new/shared — unchanged from Phase 13.5)
    │
    ▼
SipEngine (abstract)                (apps/new/shared — unchanged from Phase 13.5)
    │
    ├── MockSipEngine                (test/dev only)
    │
    └── NativeSipEngine              (apps/new/mobile/lib/sip/native_sip_engine.dart — NEW, REAL)
            │  com.supremeos/sip MethodChannel (Dart → Native)
            │  com.supremeos/sip/events EventChannel (Native → Dart)
            ▼
    Native SIP Bridge                (Android Kotlin / iOS Swift — NOT BUILT THIS PHASE, see below)
            │
            ▼
    PJSIP/PJSUA2                     (native C/C++ — NOT LINKED THIS PHASE)
```

`NativeSipEngine` is a real, tested Dart class (`apps/new/mobile/test/native_sip_engine_test.dart`,
7 passing tests) implementing the full `SipEngine` contract against a dedicated wire format. No
`pjsua`/`pjsua2`/`pjmedia`/`pjlib` type, or any native SIP object, appears anywhere above this
class — the MethodChannel/EventChannel maps are the only place native SIP concepts are ever
touched, and they are immediately translated into `sip_domain.dart`/`sip_account.dart`/
`sip_call.dart` types before reaching `SipService`.

**What does not exist yet**: the native Kotlin/Swift module that implements the OTHER end of
`com.supremeos/sip` by actually embedding `pjsua2`. This requires the actual PJSIP native SDK
(source or prebuilt AAR/`.xcframework`), a real Android/iOS build environment to compile it in,
and (per the licensing document) a resolved commercial license before any production build ships
it. None of those three preconditions exist in this environment or session. Writing native
Kotlin/Swift source that calls into a `pjsua2` API this environment cannot compile, link, or
execute would produce code whose correctness cannot be verified — the phase brief's own
instruction against claiming "native source = native acceptance" applies here: unverifiable native
glue code is not shipped as if it were real. What this phase delivers instead is the complete,
real, and tested contract that module must satisfy (the wire format `NativeSipEngine` implements)
and the architecture below it must follow.

## Wire format (com.supremeos/sip)

**MethodChannel calls (Dart → Native):**

| Method | Arguments | Native responsibility |
|---|---|---|
| `registerAccount` | `hubId, projectId, sipUri, transport, authUsername, password, doorStations[]` | Create/replace a `pjsua2::Account`, configure transport (UDP/TCP/TLS per `transport`), call `Account::setRegistration(true)` |
| `unregisterAccount` | `hubId` | `Account::setRegistration(false)`, then delete the account object |
| `answer` | `callId` | Look up the native `pjsua2::Call` for `callId`, `Call::answer(200)` |
| `hangup` | `callId` | `Call::hangup()` |
| `setMuted` | `callId, muted` | Adjust the call's audio media's transmit level to 0/nominal |
| `setSpeakerOn` | `callId, on` | Route platform audio session output (`AVAudioSession`/`AudioManager`) to speaker/earpiece |

**EventChannel frames (Native → Dart), matching `NativeSipEngine._onNativeEvent`'s exact parser:**

- `{type: "registrationStatus", hubId, state, expiresAt?, failureReason?, failureDetail?}` —
  `state` ∈ `unregistered|registering|registered|failed|expired`; `failureReason` ∈ the
  `SipFailureReason` vocabulary (`registrationFailed|authenticationFailed|network|timeout|
  rejected|unknown`); `failureDetail` is Professional-Mode-only diagnostic text, **never a
  credential**.
- `{type: "call", callId, hubId, direction, state, remoteUri, codec?, muted?, speakerOn?,
  failureReason?, failureDetail?}` — `state` ∈ `trying|ringing|connecting|active|ending|ended|
  failed`; `codec` ∈ `pcmu|pcma|g722|opus`.

An unknown `type`, or a frame missing a required field, is dropped by `NativeSipEngine`, never
thrown — proven by the "an unknown event type/state is dropped, never thrown" test. This means a
future native build can add new event shapes without breaking an older Dart build, and a
malformed/partial frame from a buggy native build cannot crash the app.

## Android architecture (design — NOT BUILT)

- Runs inside the **existing** Phase 13.3 Android runtime/foreground service — no second process,
  no second Dart isolate, per the phase brief's Single Runtime Rule.
- A Kotlin `SipBridge` class owns one `pjsua2::Endpoint` for the process lifetime, one
  `pjsua2::Account` per registered Home (`hubId`), and a `Map<String, pjsua2::Call>` keyed by
  SupremeOS `callId` (never a raw PJSIP call index, which is not stable across app process
  recreation).
- Registers the `com.supremeos/sip` MethodChannel handler and emits `com.supremeos/sip/events`
  frames from PJSIP's `Account`/`Call` callbacks (`onRegState`, `onIncomingCall`, `onCallState`,
  `onCallMediaState`).
- **ConnectionService**: used only for Android's own in-call system UI/telecom integration (the
  system "incoming call" surface, lock-screen answer/decline, audio-focus arbitration with other
  telecom apps). A `SupremeConnectionService`/`Connection` pair maps 1:1 to a SupremeOS `callId`
  the same way `SipService.mapPlatformCallId` already works for CallKit — `ConnectionService`
  itself is never given Home/authorization/device state; it only presents and relays UI events
  (answer/decline/disconnect) back through the `com.supremeos/sip` channel.
- Audio: PJSIP's own `pjmedia` audio device layer talks to Android's `AudioManager`/
  `AudioTrack`/`AudioRecord`; `setSpeakerOn` maps to `AudioManager.setSpeakerphoneOn`.

## iOS architecture (design — NOT BUILT)

- Reuses the Phase 13.4 PushKit/CallKit/native-runtime-bridge foundation. A VoIP push wakes
  `PKPushRegistryDelegate.didReceiveIncomingPushWith`, which — per the phase brief's explicit
  requirement — must not assume Dart is running yet: the native Swift `SipBridge` (analogous to
  Android's) is initialized and reachable directly from that delegate callback, independent of the
  Flutter engine's lifecycle, exactly why PJSIP (reachable from native code without Dart) was
  selected over a Dart-only SIP stack (Phase 13.5 decision doc §§7–9).
- That same push handler immediately reports the incoming call to CallKit
  (`CXProvider.reportNewIncomingCall`) so the OS presents the system call UI within Apple's
  required latency window, **before** waiting for Dart/Flutter to spin up.
- Once CallKit's `CXAnswerCallAction`/`CXEndCallAction` fire, the native bridge drives the
  `pjsua2::Call` accordingly, and — if the Flutter engine is not yet running — starts it, then
  replays the call's current state onto `com.supremeos/sip/events` so `SipService`/`MobileRuntime`
  end up with the exact same `CallSession` a foreground-started app would have built.
- No Home business logic lives in `AppDelegate` — it only wires the PushKit/CallKit delegates to
  the native `SipBridge` and the existing native-runtime-bridge channel registration, per the
  phase brief's explicit instruction.

## CallKit / ConnectionService

Both are OS-level call-presentation integrations only, per Phase 13.5's design and reaffirmed here:
neither is given SIP credentials, bearer tokens, private keys, or Home secrets in its metadata —
only a display label (door station name) and the platform call UUID, which `SipService.
mapPlatformCallId` already maps to `(hubId, callId)` without ever touching a credential.

## Audio (design — NOT BUILT)

Real audio requires `pjmedia`'s RTP/SRTP media engine linked into the native bridge described
above; `NativeSipEngine.setMuted`/`setSpeakerOn` already define the Dart-side control surface that
implementation must respond to. SRTP is enabled per-account when the door station's own
configuration calls for it (matching `SipTransport.tls` accounts to SRTP, matching the common
doorphone-vendor convention of pairing SIP-TLS with SRTP).

## Codecs

Per the licensing document §5: **PCMU, PCMA, G.722, Opus** — no additional codec-patent license
required. G.729/AMR/AMR-WB/Siren are explicitly excluded at PJSIP build-configuration time (a
`pjproject` compile flag), not merely left unadvertised in SDP, since compiling in an unlicensed
codec and simply not offering it is not a safe posture (a bug could re-enable it).

## Networking / NAT

LAN-first, matching the existing Home network topology (Phase 13.5 architecture doc's Networking
section, unchanged): the Hub's own SIP proxy/registrar and door stations are expected on the same
residential LAN as the phone. STUN is planned as a documented, opt-in configuration for the
mobile-data-only scenario (calling home while away, LAN-first still preferred when available);
TURN is **not planned** — there is no architectural reason to relay SIP media through a TURN
server for a residential intercom whose realistic topology is "same LAN or nothing," and adding
one merely because PJSIP supports it would violate the phase brief's explicit "do not add TURN
just because it exists." The Tunnel Broker (Hub control-plane remote access) is confirmed, again,
to carry no SIP RTP — the two transports remain architecturally separate.

## Security

- Credentials: `SipCredentials.password` crosses the `com.supremeos/sip` MethodChannel exactly
  once per `registerAccount` call and is never included in an EventChannel frame, a log line, a
  CallKit/ConnectionService metadata field, or a crash report — enforced today at the Dart layer
  (`SipCredentials.toString()` redaction, `SipService` never retaining it) and to be enforced at
  the native layer by never persisting the raw method-call arguments beyond the immediate
  `pjsua2::AccountConfig` construction.
- Secure storage: production credential persistence (so a registered Home's password survives app
  restart) is a `SipCredentialStore`-shaped responsibility analogous to the existing
  `PairedHomeAuthorizationStore`/secure-storage pattern — **not built this phase** (no caller
  needs it yet, since no native engine exists to actually register against); tracked as
  `PRODUCTION HARDENING REQUIRED` in the final report.

## Multi-Home / multiple door stations

Unchanged from Phase 13.5 (`SipService` keyed by `hubId`, `SipAccountConfig.doorStations` keyed by
`doorStationId`/`remoteUri`) — this phase adds no new multi-Home logic, only a real transport
beneath the existing, already-isolated orchestration layer. The native Android/iOS bridge design
above mirrors this: one `pjsua2::Account` per `hubId`, never a single global account.

## Lifecycle

`NativeSipEngine`'s own lifecycle is `construct → (registerAccount/unregisterAccount calls) →
dispose` — `dispose()` cancels the native event subscription and closes both stream controllers,
proven by every test in `native_sip_engine_test.dart` calling it. The native bridge's own
`initialize/start/stop/dispose` (the phase brief's explicit requirement) maps to:
`initialize` = construct the `pjsua2::Endpoint` once per process; `start` = implicit in the first
`registerAccount` call; `stop` = `unregisterAccount` for every Home; `dispose` = destroy the
`Endpoint` when the Android foreground service or iOS process is actually terminating — this exact
sequencing is design-only in this phase (no native code exists to execute it).

## Failure recovery

`NativeSipEngine` already drops any malformed/unknown event rather than throwing (§ Wire format
above) — this is the same resilience posture `SipService` already has (Phase 13.5) for engine-level
events. The native bridge's own responsibility (design-only) is to never let a `pjsua2` callback
exception cross into a Dart-visible crash — every native callback must catch and translate into a
`failed`/`failureReason` event rather than letting an uncaught native exception propagate.
