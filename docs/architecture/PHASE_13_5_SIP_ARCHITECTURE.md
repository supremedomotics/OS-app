# Phase 13.5 — SIP Architecture

Companion to [PHASE_13_5_SIP_STACK_DECISION.md](PHASE_13_5_SIP_STACK_DECISION.md). Describes what
was actually built this phase and how it fits the existing SupremeOS Mobile runtime.

## Selected SIP stack

PJSIP/PJSUA2, wrapped in a native Android/iOS platform-channel module (see decision doc §17). That
native module is **not implemented in this environment** (no macOS/Xcode, no working Android
build — established since Phase 13.1) and is tracked as `NATIVE BUILD ACCEPTANCE REQUIRED` in the
final report. What this phase built is everything above that seam: the SupremeOS-level domain
model, `SipService` orchestrator, and a deterministic mock engine the whole thing is proven
against.

## SupremeOS abstraction

```
SupremeOS UI / RuntimeController
        │
        ▼
   SipService            (apps/new/shared/lib/src/sip/sip_service.dart)
        │
        ▼
    SipEngine             (abstract — apps/new/shared/lib/src/sip/sip_engine.dart)
        │
        ├── MockSipEngine  (this phase's test/dev implementation)
        └── [PJSIP native platform-channel engine]  (NATIVE BUILD ACCEPTANCE REQUIRED)
```

Domain types (`sip_domain.dart`, `sip_account.dart`, `sip_call.dart`) carry no PJSIP-specific
concept anywhere — `SipEngine` is the only place a concrete implementation's own types are ever
touched, and swapping PJSIP for Linphone (the documented fallback) means writing a new class that
implements `SipEngine`; nothing above that line changes.

`SipService` does not introduce a parallel call model. It translates engine-level `SipCall`/
`SipCallState` into the **existing** `CallSession`/`CallState` (`apps/new/shared/lib/src/runtime/
home_event.dart`, established Phase 12.5/13.1) and drives them through the **existing**
`MobileRuntime` state machine (`mobile_runtime.dart`) — reused exactly as designed, including its
already-correct deterministic transition table and multi-Home isolation
(`isAuthorizedForHub`/`updateAuthorizedHomes`). `CallSession` gained one new field this phase,
`doorStationId` (nullable, backward compatible), to carry the multi-door-station identity this
phase requires.

## Data flow — incoming call

```
Door Station (physical SIP endpoint)
    │  SIP INVITE
    ▼
SipEngine (PJSIP, native)              — sees the INVITE first, can wake CallKit before Dart runs
    │  SipCall{state: trying, remoteUri, hubId}
    ▼
SipService._onEngineCall
    │  resolves remoteUri -> SipDoorStationConfig via SipAccountConfig.doorStationFor
    │  builds CallSession{state: incoming, doorStationId, doorStationLabel}
    ▼
MobileRuntime.ingestIncomingCall
    │  (isAuthorizedForHub check already inside MobileRuntime)
    ▼
RuntimeController / CallKit / Android call integration   — NATIVE, not built this phase
    ▼
SupremeOS homeowner UI
```

Every subsequent SIP-side state change (`ringing`→`connecting`→`active`→`ending`→`ended`/`failed`)
flows through `SipService._onEngineCall` → `MobileRuntime.transitionCall`, which rejects any
transition its own table (unchanged from Phase 12.5) doesn't allow — a duplicate or out-of-order
engine callback is dropped, never crashes the runtime.

## Lifecycle

- **Registration**: `SipService.configureHome(SipAccountConfig, SipCredentials)` →
  `SipEngine.registerAccount`. Status (`unregistered/registering/registered/failed/expired`) is
  per-`hubId`, streamed back through `SipService.registrationStatus`, and dropped for any `hubId`
  `SipService` never configured (a stale callback racing `removeHome`, or a malformed event).
- **Call**: `idle → incoming → ringing → connecting → connected → ending → ended` (or `failed` from
  most states) — this is `CallState`'s existing 8-state table, unmodified.
- **Teardown**: `removeHome(hubId)` unregisters the account and clears local status; an in-flight
  call's terminal state (`ended`/`failed`) clears `SipService`'s internal `callId → hubId` and
  CallKit-UUID maps.

## Home association / multi-door-station model

`SipAccountConfig` is per-`hubId` (one SIP account per Home, registered against that Home's own
Hub-embedded proxy/registrar — never a single global account). It carries a `List<
SipDoorStationConfig>`, each with a stable `doorStationId`, a homeowner-facing `label`, and the
door station's own SIP `remoteUri` — the only thing `SipService` uses to resolve which door
station is calling (`doorStationFor`, an exact match, never a display-name guess; an unmapped
remote URI still rings, with `doorStationId`/`doorStationLabel` left `null` rather than fabricated).
Two Homes' accounts, calls, and door-station configs are independent `SipService`-internal map
entries keyed by `hubId` — proven by the Home A/Home B isolation tests in
`apps/new/shared/test/sip_service_test.dart`.

## Android integration

Not built this phase (native build unavailable in this environment — see decision doc §20). The
design constraint this phase locks in: the PJSIP native module runs inside the **existing** Phase
13.3 Android runtime/foreground-service process — no second runtime, no second Dart isolate. If
`ConnectionService` is used for the system call UI, it owns OS-level call presentation only; the
authoritative call model remains `SipService`/`MobileRuntime`/`CallSession`, reached the same way
`NativeRuntimeBridge` already reaches Dart (`com.supremeos/runtime` channel family) — a new
`incomingCall`/`callStateChanged` event shape already exists on that channel from Phase 13.1
(`NativeRuntimeBridge._onNativeEvent`'s `incomingCall`/`callStateChanged` cases), so no new channel
is needed, only a real native emitter behind it.

## iOS integration

Not built this phase, same reason. Design constraint: PushKit wakes native Swift code, which must
be able to hand the INVITE to the (native-embedded) PJSIP engine and populate CallKit **without
assuming Dart is already running** — this is exactly why PJSIP (reachable from native code
directly) was chosen over a Dart-only signaling stack (decision doc §§7–9). Dart is activated
afterward through the same native runtime bridge Phase 13.1 already established.

## Audio architecture

Not built this phase — real RTP/SRTP audio requires the native PJSIP engine, which doesn't exist
in this build yet. `SipAudioState` (mute/speaker booleans) and `SipEngine.setMuted`/
`setSpeakerOn` define the contract a real engine must satisfy; `MockSipEngine`'s implementations
are no-ops, honestly not claiming real audio.

## Networking

SIP signaling/media is LAN-first, following the existing Home network topology — the Hub's own
embedded SIP proxy/registrar and the door stations sit on the same residential LAN as the Hub
(§ decision doc §11). Per the phase brief's explicit instruction, **the Tunnel Broker is not
assumed to carry SIP RTP** — remote-access voice calling (calling home from outside the LAN) is
out of scope for this phase's implementation and is not implemented; only LAN-local
registration/calls are modeled. `SipService` has no dependency on `ConnectionManager`/Tunnel
Broker at all, keeping the two transports (Hub control vs. SIP media) architecturally separate as
required.

## Security

- `SipCredentials` (§ `sip_account.dart`) redacts its password in `toString()`; `SipService` never
  stores a `SipCredentials` instance beyond the single `registerAccount` call — see the "credentials
  are never retained" test.
- The CallKit-UUID map (`SipService.mapPlatformCallId`) holds only two plain identifiers per
  entry; refuses to map an unknown/forged `callId` (test: "refuses to map a platform UUID to an
  unknown/forged callId").
- `answer`/`hangup`/`setMuted`/`setSpeakerOn` all check `_callHomes` before forwarding to the
  engine — a forged or stale `callId` is a silent no-op, never forwarded (§ "no command execution
  from calls" tests).
- `SipService` has **no door-unlock/release method at all** — not a disabled one, an absent one.
  Answering a call and unlocking a door are structurally unrelated capabilities in this codebase;
  door release is Phase 13.7's own, separately-authorized design.

## Diagnostics

`SipRegistrationStatus` and `SipCall` carry everything Professional Mode diagnostics will
eventually need (registration state/expiry/last failure, call state, negotiated codec, audio
state) — no diagnostics UI was built this phase (not yet required), but the data these screens
would read already exists on these types without any redesign.

## Failure handling

- Malformed/duplicate/out-of-order engine events are dropped, never thrown, at three points:
  `_onRegistrationStatus` (unconfigured Home), `_onEngineCall` (unconfigured Home; unknown call in
  a non-`incoming` state; duplicate state == current state), and any `MobileRuntime.transitionCall`
  `StateError` (illegal transition) is caught and swallowed rather than propagated.
- Network-transition recovery (Wi-Fi↔mobile data, LAN↔remote) is the existing `ConnectionManager`
  reconnect path for Hub control traffic and is explicitly **not** something `SipService` re-
  implements; SIP registration's own reconnect/backoff is a `SipEngine`-internal concern (a real
  PJSIP engine implementation owns re-`REGISTER` on transport-loss, per SIP's own registration
  lifecycle) that `MockSipEngine` does not simulate since there is no real transport under it to
  lose.

## Future video compatibility

`SipCall` and `CallSession` are voice-only this phase (`CallMedia.voice`; `CallMedia.video` already
exists as an enum value from the pre-existing model but nothing in this phase sets or handles it).
Phase 13.6's video work can add a video capability to `SipCall`/`SipEngine` (codec negotiation,
frame delivery) without touching `SipService`'s registration/multi-Home/multi-door-station logic,
which is media-kind-agnostic by construction.
