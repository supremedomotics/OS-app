import 'dart:async';

import 'sip_account.dart';
import 'sip_call.dart';

/// The ONE seam between SupremeOS and a concrete SIP implementation (§Phase13.5 §"ARCHITECTURAL
/// DECISION"): `SupremeOS -> SipService -> SipEngine -> [selected SIP implementation]`. Nothing
/// outside a `SipEngine` implementation may reference a specific SIP library's own types —
/// `SipService` and everything above it speaks only `sip_domain.dart`/`sip_account.dart`/
/// `sip_call.dart`.
///
/// Per `docs/architecture/PHASE_13_5_SIP_STACK_DECISION.md`, the selected engine is PJSIP/PJSUA2
/// via a native Android/iOS platform-channel module — that module does not exist yet in this
/// environment (no macOS/Xcode, no working Android build; see that document's Risks §20) and is
/// classified `NATIVE BUILD ACCEPTANCE REQUIRED` in the Phase 13.5 final report. This interface
/// is the contract that native module must satisfy; `MockSipEngine` (this package) is the
/// deterministic, test-only implementation this phase's own test suite runs against.
abstract class SipEngine {
  Stream<SipRegistrationStatus> get registrationStatus;
  Stream<SipCall> get calls;

  /// §Phase13.6A — explicit engine lifecycle (separate from any one Home's account lifecycle):
  /// constructs the underlying SIP endpoint/media stack once per process. Must be called before
  /// [registerAccount] and is idempotent-safe to call again after [stop] (e.g. app foregrounded
  /// again after being backgrounded/killed and restored). A native implementation failing to
  /// initialize (missing hardware, out-of-memory, a corrupt native library) surfaces as a thrown
  /// exception here — `SipService` is responsible for deciding what a homeowner sees for that,
  /// never for retrying silently in a loop.
  Future<void> initialize();

  /// Tears down the underlying SIP endpoint/media stack (all accounts implicitly unregistered) —
  /// the counterpart to [initialize], distinct from [dispose] which additionally releases this
  /// Dart object's own streams/subscriptions and can never be un-done. `stop` alone leaves the
  /// engine object reusable via another [initialize] call.
  Future<void> stop();

  Future<void> registerAccount(SipAccountConfig config, SipCredentials credentials);
  Future<void> unregisterAccount(String hubId);

  Future<void> answer(String callId);
  Future<void> hangup(String callId);
  Future<void> setMuted(String callId, bool muted);
  Future<void> setSpeakerOn(String callId, bool on);

  Future<void> dispose();
}
