/// SupremeOS SIP domain vocabulary (§Phase13.5 §"SIP DOMAIN ABSTRACTION"). Pure Dart, no SIP
/// library types anywhere in this file — this is the seam `SipEngine` implementations translate
/// into and out of, so the rest of SupremeOS (Home/MobileRuntime/CallSession/Hub/Touch Panel)
/// never depends on a specific SIP stack's own model (PJSIP, Linphone, or otherwise — see
/// `docs/architecture/PHASE_13_5_SIP_STACK_DECISION.md`).
library;

enum SipCallDirection { incoming, outgoing }

/// The SIP-engine-level call lifecycle — deliberately richer than the homeowner-facing
/// `CallState` (`idle/incoming/ringing/connecting/connected/ending/ended/failed`) only where the
/// SIP layer itself has a real distinct signal (`trying` — INVITE sent/received, not yet
/// provisionally answered). `SipService` maps this DOWN onto `CallState` for anything that
/// reaches `MobileRuntime`; this enum never itself reaches the UI.
enum SipCallState { trying, ringing, connecting, active, ending, ended, failed }

enum SipTransport { udp, tcp, tls }

/// Codec set actually supported by the chosen engine/door-station population (§ decision doc
/// §12) — G.711 variants and G.722 are the realistic floor; Opus included for newer hardware.
/// Never extended "for completeness" without a real device/codec requiring it (§ CODECS: "do not
/// add codecs merely for marketing").
enum SipCodec { pcmu, pcma, g722, opus }

/// Real-time audio-session state for an active `SipCall` — mic/speaker only; this is NOT
/// `AndroidServiceState`/`ProcessState`/`UiState`, which stay independent per §Phase13.5.
class SipAudioState {
  final bool microphoneMuted;
  final bool speakerOn;

  const SipAudioState({this.microphoneMuted = false, this.speakerOn = false});

  SipAudioState copyWith({bool? microphoneMuted, bool? speakerOn}) => SipAudioState(
        microphoneMuted: microphoneMuted ?? this.microphoneMuted,
        speakerOn: speakerOn ?? this.speakerOn,
      );
}

enum SipFailureReason {
  registrationFailed,
  authenticationFailed,
  network,
  timeout,
  rejected,
  unknown,
}

/// A SIP-layer failure — reason is a closed, homeowner-safe vocabulary; [detail] is for
/// Professional Mode diagnostics ONLY (§ DIAGNOSTICS: never shown to homeowners) and must never
/// itself contain a credential (enforced by callers — see `SipService`'s own doc).
class SipFailure {
  final SipFailureReason reason;
  final String detail;
  const SipFailure(this.reason, this.detail);

  @override
  String toString() => 'SipFailure(${reason.name})'; // detail deliberately omitted from toString
}
