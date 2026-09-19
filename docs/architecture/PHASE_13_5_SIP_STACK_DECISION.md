# Phase 13.5 — SIP Stack Decision

Step 0 of Phase 13.5 (SIP Voice Communication). This document evaluates realistic SIP
technology options for SupremeOS's mobile residential runtime and makes an architectural
decision **before** any SIP engine code is written, per the phase brief's explicit gate.

## 1. Requirements

Derived from the phase brief and from what SupremeOS already is (a 10+ year, local-first,
abstraction-first residential platform, Phases 1–13.4):

- Real interoperability with **physical SIP door stations/intercoms** already deployed in the
  field (Akuvox, Fanvil, 2N, DoorBird, Comelit, and generic Asterisk/FreePBX-fronted analog
  gateways are the realistic device population this feature exists to talk to). These are
  legacy SIP/RTP endpoints: UDP/TCP/TLS SIP, plain RTP or SRTP, G.711 (PCMU/PCMA) and G.722 as
  the near-universal codec floor, DTMF via RFC 2833/telephone-event.
- Real background incoming-call delivery on iOS (PushKit → CallKit) and Android (high-priority
  FCM → foreground service/ConnectionService), building on the Phase 13.2–13.4 push/runtime
  foundation — not a polling model.
- A single Dart/Flutter codebase for UI and orchestration, consistent with every other
  SupremeOS surface.
- Multi-Home, multi-door-station isolation (§ this phase's own mandatory requirement) — the SIP
  layer must not assume one global account.
- A 10+ year maintenance horizon: the stack's maintainer, license, and community health matter
  as much as today's feature checklist.
- Commercial redistribution: SupremeOS is a commercial product: the license must permit shipping
  a closed-source app built on the stack, at a cost and process that is knowable up front.
- The stack must become an **implementation detail** behind a SupremeOS abstraction
  (`SipService`/`SipEngine`), never something the rest of the app depends on directly.

## 2. Candidate Stacks

### A. PJSIP / PJSUA2 (Teluu)

A mature (20+ years), native C SIP/media stack with a C++ (PJSUA2) and Python layer built in.
No official Dart/Flutter binding exists; integration means writing native Android (Kotlin/JNI)
and iOS (Swift/Obj-C++) modules that embed `pjsua2` and exposing them to Dart over a platform
channel — the same architectural pattern already used for the Phase 13.1 native runtime bridge
(`com.supremeos/runtime`). This is the stack underneath a large share of the commercial SIP
softphone/intercom-app market (historically Linphone before their fork, Zoiper, many white-label
intercom apps from the door-station vendors above).

### B. Linphone SDK (liblinphone, Belledonne Communications)

A complete, "batteries-included" SIP+media SDK (built on their own belle-sip/mediastreamer2, not
PJSIP) with official Android AAR and iOS `.xcframework` builds, and Belledonne's own published
guides for CallKit and PushKit integration. Several door-station vendors' own "companion apps"
are themselves Linphone-SDK-based, so interoperability with this device population is
well-proven in the field. Dual-licensed: GPLv3 for open-source use, or a paid commercial license
from Belledonne for closed-source redistribution.

### C. WebRTC + SIP-over-WebSocket (`sip.js`, `JsSIP`, Dart's `dart_sip_ua`)

Pure-JS/Dart SIP signaling (parses/builds SIP messages itself) layered on a WebRTC media engine
for RTP/SRTP — in Flutter, `dart_sip_ua` (MIT) is the maintained option, built on
`flutter_webrtc`. Attractive because it is pure Dart signaling with no custom native SIP engine
to bind. But the media path is WebRTC's own engine, which is DTLS-SRTP-first and ICE-oriented;
legacy door stations that speak plain RTP/AVP (no DTLS handshake) are a well-known compatibility
gap for WebRTC-based SIP clients unless the far end also does DTLS-SRTP or the stack is
specifically configured for plain AVP (patchy, per-endpoint tuning territory, not a general
guarantee). Background/CallKit/PushKit integration is not provided by the library at all — it
would have to be built at the same level of effort as with PJSIP, but on top of a media engine
less proven against this specific device population.

### D. Native platform SIP APIs

iOS has no public SIP framework. Android had `android.net.sip` (deprecated for years, unreliable,
effectively unusable on modern Android). Neither is viable as a foundation; native platform SIP
support does not exist as a real candidate today.

### E. Other production stacks considered and set aside

- **Sofia-SIP** (used inside FreeSWITCH) — a signaling-only library with no first-class mobile
  (Android/iOS) build story or maintained mobile bindings; would require even more integration
  work than PJSIP for less mobile-specific payoff.
- **reSIProcate** — signaling-focused, C++, no mobile media stack of its own, weaker mobile
  community/precedent than PJSIP.
- **Commercial white-label SDKs (e.g. from CPaaS vendors)** — rejected outright: SupremeOS is
  local-first and must operate without a cloud dependency for Home communication (§ existing
  LAN-first/Tunnel Broker principle); a CPaaS SDK implies routing SIP signaling and/or media
  through the vendor's cloud, which is architecturally incompatible with this product.

## 3. Architecture Comparison

| | PJSIP/PJSUA2 | Linphone SDK | dart_sip_ua (WebRTC) |
|---|---|---|---|
| Signaling engine | Native, purpose-built SIP stack | Native, purpose-built SIP stack | Dart, hand-rolled SIP parsing |
| Media engine | Native RTP/SRTP, wide legacy-codec support | Native RTP/SRTP (mediastreamer2), wide legacy-codec support | WebRTC (`libwebrtc`), DTLS-SRTP-first |
| Flutter binding | None official — custom platform channel required | None official — custom platform channel required | Native Dart/Flutter package |
| Opinionatedness | Low — a toolkit, SupremeOS designs the call model | High — ships its own account/call/chat model that must be adapted, not adopted wholesale | Low-medium — a SIP UA class, thin |
| Legacy door-station interop | Proven (near-universal in this device category) | Proven (several vendors' own apps are Linphone-based) | Uncertain for plain-RTP endpoints |
| Diagnostics | Full SIP/RTP packet-level logging built in (`pjsua2` logging, easy to surface) | Full logging built in | Limited to what `dart_sip_ua`/`flutter_webrtc` expose |

## 4. Licensing Comparison

| | License | Commercial redistribution |
|---|---|---|
| PJSIP/PJSUA2 | GPLv2, **or** a commercial license from Teluu | Buy a commercial license from Teluu to ship closed-source (well-established, published process; cost scales with deployment, not per-unit royalty in the common arrangement) |
| Linphone SDK | GPLv3, **or** a commercial license from Belledonne Communications | Same shape as PJSIP — buy a commercial license to ship closed-source |
| dart_sip_ua | MIT | No commercial license needed for the signaling layer itself; `flutter_webrtc`'s underlying `libwebrtc` is BSD-style (Google), also unencumbered |
| Sofia-SIP / reSIProcate | Permissive (LGPL/BSD-family) | Not a blocker, but set aside above for other reasons |

**This is the central tradeoff of this decision.** The two stacks with proven legacy
door-station interoperability (PJSIP, Linphone) both require a paid commercial license for
closed-source redistribution. The one royalty-free stack (`dart_sip_ua`) carries real
interoperability risk against exactly the device population this feature exists to serve.

## 5. Android Implications

None of the candidates has a batteries-included Android "just works" story for a Flutter app.
PJSIP and Linphone both ship Android build artifacts (AAR / native `.so` via NDK) that a custom
Kotlin module wraps and exposes over a platform channel or Pigeon-generated API — the same shape
as the Phase 13.1 `com.supremeos/runtime` bridge, so this is an established pattern for this
codebase, not a new one. `dart_sip_ua` avoids that native module entirely but inherits
`flutter_webrtc`'s own (larger) native footprint instead.

## 6. iOS Implications

Same shape as Android: PJSIP/Linphone need a native Swift module wrapping their iOS framework
build; `dart_sip_ua` needs none for signaling but still needs `flutter_webrtc`'s native pod.
Critically, **none of the three affects the PushKit/CallKit integration effort** — that native
wake-and-present path (Phase 13.4's foundation) has to be hand-built regardless of which SIP
engine answers the call once Dart/native code is running; the SIP stack choice does not save or
cost work here.

## 7. Background-Call Implications

All three require the same fundamental design: a VoIP push (iOS) or high-priority FCM message
(Android) wakes the native side, which must be able to reach the SIP engine and accept the
INVITE *without* necessarily having a live Dart isolate yet. This favors an engine that is
usable directly from native code (PJSIP's C API and Linphone's native SDKs both are) over one
that only has a Dart API (`dart_sip_ua`, which would require Dart to already be running to touch
the SIP stack at all — a materially worse fit for "wake from terminated state" per this phase's
own iOS requirements).

## 8. PushKit Implications

Confirms §7: PushKit's contract is "wake native code, present CallKit UI immediately." An engine
reachable from native Swift without Dart already running is the only way to honor "do not assume
Dart is already alive," which the phase brief states explicitly. This rules out
`dart_sip_ua` as the sole SIP path for the incoming-call wake step regardless of its other merits.

## 9. CallKit Implications

CallKit itself is orthogonal to the SIP engine choice — it is Apple's call-presentation API and
must be integrated in native Swift regardless. What the SIP engine choice affects is *when* the
SIP INVITE can be inspected to populate CallKit's incoming-call metadata (caller/door-station
identity): with PJSIP/Linphone this can happen natively, before/without Dart; with
`dart_sip_ua` it cannot.

## 10. RTP/SRTP Implications

PJSIP and Linphone both implement classic RTP/AVP and SRTP/SAVP natively and interoperate with
plain-RTP legacy endpoints as a first-class case (this is the majority of the current door-station
market). `dart_sip_ua`'s WebRTC media path is DTLS-SRTP/AVPF-oriented; talking to a plain-RTP
door station either doesn't work or requires non-standard configuration on both ends.

## 11. NAT Traversal

All are LAN-first for SupremeOS's actual deployment (door station and Hub on the same residential
LAN as the phone, or reachable via the existing Remote Access/Tunnel Broker path for control —
see §13). STUN/ICE matter far less here than in general-purpose VoIP, since the realistic
topology is "same LAN or hub-mediated," not "two arbitrary NATed endpoints on the public
internet." PJSIP and Linphone both support STUN/TURN/ICE if ever needed for a mobile-data-only
scenario; `dart_sip_ua`/WebRTC's ICE stack is more mature *as ICE* (it's WebRTC's native
strength) but that strength is largely wasted here since it doesn't fix the plain-RTP
interoperability gap.

## 12. Codec Support

PJSIP and Linphone: G.711 (PCMU/PCMA), G.722, GSM, iLBC, Opus, and others depending on build
flags — matches the realistic door-station codec set (G.711/G.722 near-universal, some newer
devices offer Opus). `dart_sip_ua`/WebRTC: Opus-first, G.711 available, G.722 support depends on
the underlying `libwebrtc` build — codec overlap with legacy hardware is narrower.

## 13. Multi-Home Implications

Architecturally neutral: whichever engine is chosen sits behind `SipService`, which is what
actually owns per-Home isolation (§ this phase's mandatory multi-Home model, see the companion
architecture document). PJSIP/Linphone both support multiple simultaneous registered accounts
natively, which maps cleanly onto "one `SipAccount` per Home." `dart_sip_ua` also supports
multiple `UA` instances; this criterion does not separate the candidates.

## 14. Multiple-Door-Station Implications

Same as §13 — this is a `SipService`/domain-model concern (one `SipAccount`/`SipEndpoint` per
door station, keyed by `hubId`/`homeId`/`doorStationId`), not a SIP-engine concern. All
candidates support registering multiple accounts/endpoints concurrently.

## 15. Security

All three support SIP over TLS and SRTP. Credential storage, log redaction, and the
CallKit-UUID-to-CallSession mapping are `SipService`-level concerns regardless of engine (see the
architecture document's Security section) — this criterion does not separate the candidates
except that PJSIP/Linphone's native diagnostics make it easier to *prove* TLS/SRTP is actually
negotiated (visible in native logs) versus WebRTC's less door-station-specific instrumentation.

## 16. Long-Term Maintenance

- **PJSIP**: actively maintained by Teluu since 2003, used in large commercial deployments,
  predictable commercial-licensing relationship, strong track record of surviving mobile OS
  churn (it pre-dates iOS and Android and has tracked both for their entire lifetimes).
- **Linphone SDK**: actively maintained by Belledonne Communications, similarly long-lived,
  slightly more opinionated (it wants to be more of a full UA, not just a toolkit), which is a
  maintenance cost if SupremeOS's own call model ever needs to diverge from Linphone's
  assumptions.
- **dart_sip_ua**: maintained by a small team (the `flutter_webrtc` maintainers), MIT, healthy
  activity, but a much shorter track record and, per §§7–12, a real compatibility gap against
  this feature's actual target hardware — the long-term risk here is architectural
  (compatibility), not abandonment.

## 17. Recommended Architecture

**PJSIP/PJSUA2, wrapped in a native Android (Kotlin) and iOS (Swift) module, exposed to Dart
through a platform-channel boundary analogous to Phase 13.1's `com.supremeos/runtime` bridge, and
never referenced directly outside a single `SipEngine` implementation.**

Rationale, weighing the tradeoffs above rather than picking on convenience:

- It is the toolkit (not a full opinionated UA) with the least architectural friction against
  SupremeOS's own `SipService`/`CallSession` model — SupremeOS designs the call model, PJSIP
  provides the SIP/RTP primitives underneath it, matching the "engine replaceable without
  redesigning Home/MobileRuntime/CallSession" requirement from the phase brief better than
  Linphone's more opinionated SDK would.
- Proven legacy-door-station interoperability (plain RTP/AVP, G.711/G.722, DTMF via
  telephone-event) — the actual hardware population this feature exists to serve.
- Reachable from native code without requiring Dart to already be running — the only real fit
  for "PushKit wakes native code, which must be able to touch the SIP engine before Dart is
  alive."
- A known, purchasable commercial license (same shape as Linphone's, chosen here over Linphone
  specifically for the lower architectural friction above).
- 20+ years of continuous maintenance and a mobile-OS track record that pre-dates both target
  platforms — the strongest available signal for a 10-year horizon.

**The commercial PJSIP license purchase is a real, non-technical dependency this phase surfaces
but cannot resolve** — see the Risks/Stop-Gate section below.

## 18. Rejected Alternatives

- **Linphone SDK** — a strong, credible second choice, rejected only because it is a more
  opinionated full-UA SDK than PJSIP's toolkit shape, which fits less cleanly behind a
  from-scratch `SipService`/`CallSession` model that must stay independent of any one engine's
  assumptions. If PJSIP's commercial-licensing path turns out to be impractical for SupremeOS's
  business terms, Linphone SDK is the recommended fallback — the architecture in this phase
  (SipEngine seam) is designed so that swap would not require touching `Home`, `MobileRuntime`,
  `RuntimeController`, `CallSession`, `Hub`, or Touch Panel.
- **`dart_sip_ua` / WebRTC-based signaling** — rejected as the primary engine due to (a) real
  compatibility risk against plain-RTP legacy door stations, and (b) being unreachable from
  native code before Dart is alive, which conflicts with the PushKit "do not assume Dart is
  already alive" requirement. Worth revisiting only if SupremeOS's supported door-station
  ecosystem shifts decisively toward WebRTC-native devices, which is not the current or
  near-term reality.
- **Sofia-SIP, reSIProcate** — rejected for materially weaker mobile-platform precedent and
  build tooling than PJSIP/Linphone, for no offsetting benefit.
- **Native platform SIP APIs** — not viable; no real candidate exists on either OS.
- **Any CPaaS/cloud-relay SDK** — rejected outright as incompatible with SupremeOS's local-first,
  no-cloud-dependency architecture for Home communication.

## 19. Reasons for Rejection (summary)

| Candidate | Primary reason rejected |
|---|---|
| Linphone SDK | More opinionated full-UA shape than PJSIP's toolkit shape; kept as the documented fallback |
| dart_sip_ua/WebRTC | Legacy plain-RTP interoperability risk; not reachable from native code before Dart is alive |
| Sofia-SIP / reSIProcate | Weak mobile precedent/tooling relative to PJSIP/Linphone |
| Native platform SIP APIs | Do not exist in a usable form on either target OS |
| CPaaS/cloud SDKs | Incompatible with local-first, no-cloud-dependency architecture |

## 20. Risks

1. **Commercial licensing cost/process for PJSIP is not yet known to this project.** This is a
   business decision (contacting Teluu, negotiating terms) that engineering cannot resolve
   inside this phase.
2. **No official Flutter/Dart binding exists for PJSIP** — the native platform-channel module
   is new engineering work, not a drop-in dependency. This is real effort, not risk-free.
3. **This build environment cannot compile or run native Android/iOS code at all** (established
   in Phases 13.1–13.4: no macOS/Xcode, Android Gradle loopback-socket failure, no working
   `adb`). The native PJSIP binding therefore cannot be built, compiled, or device-tested in
   this environment this phase — it can only be designed, and its Dart-facing contract can only
   be implemented against a mock/stub engine.
4. **GPL fallback is not viable for a commercial closed-source product** if the commercial
   license path stalls — there is no license-free path to PJSIP or Linphone for this product.

## 21. Mitigations

1. This document, and the accompanying architecture document, define the `SipEngine` seam
   specifically so that the commercial-licensing question (risk 1) can be resolved in parallel
   with, or even after, the domain-model engineering in this phase — no code in this phase
   depends on having already signed a PJSIP license.
2. The native platform-channel module (risk 2) is scoped as its own deliverable
   (`SipEngine` implementation) with an explicit, honest classification of
   `NATIVE BUILD ACCEPTANCE REQUIRED` / `PRODUCTION HARDENING REQUIRED` in the Phase 13.5 final
   report — it is not claimed as done because it cannot be.
3. Because of risk 3, this phase implements and tests the full `SipService`/domain-model/call
   state-machine layer against a deterministic mock `SipEngine`, proving the abstraction and its
   multi-Home/multi-door-station isolation logic with real, passing `flutter test` coverage,
   while being explicit that the production PJSIP engine itself is
   `NATIVE BUILD ACCEPTANCE REQUIRED` and `REAL-WORLD ACCEPTANCE TEST REQUIRED`.
4. Risk 4 is a business risk, not an engineering one, and is called out plainly rather than
   worked around technically (there is no technical workaround for a licensing requirement).

## Evaluation Conclusion

The evaluation is **sufficiently conclusive to proceed into implementation in this phase**, per
the phase brief's own stop condition: there is no unresolved *architectural* or *platform*
blocker — PJSIP is a sound, well-precedented choice, and the `SipEngine` seam means the one real
open question (commercial license procurement) does not block engineering. That licensing
question, and the native-build/device-testing gap inherent to this environment, are surfaced
honestly above and carried into the Phase 13.5 final report's classification matrix rather than
hidden or silently assumed away.

**This is not** an "ARCHITECTURE DECISION REQUIRES REVIEW" stop — implementation proceeds.
