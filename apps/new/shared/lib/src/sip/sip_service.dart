import 'dart:async';

import '../runtime/home_event.dart';
import '../runtime/mobile_runtime.dart';
import 'sip_account.dart';
import 'sip_call.dart';
import 'sip_domain.dart';
import 'sip_engine.dart';

/// SupremeOS's own SIP orchestrator (§Phase13.5) — the only thing above it is homeowner UI/
/// `RuntimeController`; the only thing below it is a `SipEngine`. Owns:
///
/// - per-Home account configuration and registration status (§ "Do NOT use one global SIP
///   account" — everything here is keyed by `hubId`, never a single global account/call)
/// - matching an inbound call's raw remote SIP URI to a configured door station (§ MULTIPLE DOOR
///   STATIONS)
/// - translating engine-level `SipCall`/`SipCallState` into the homeowner-facing
///   `CallSession`/`CallState` already established by `MobileRuntime` (Phase 12.5/13.1) — this is
///   deliberately REUSE, not a parallel call model (§ "extend, don't fork")
/// - the CallKit-UUID ↔ `(hubId, callId)` mapping (§ CALLKIT) — never anything more than that
///   pairing; no credential of any kind is ever stored in this map
///
/// STRUCTURALLY DOES NOT EXPOSE a door-unlock/release method — there is no such method on this
/// class, not a disabled one (§ DOOR RELEASE: "Answer call ≠ Unlock door"). Door release is a
/// Phase 13.7 concern with its own, separate authorization design.
class SipService {
  final SipEngine _engine;
  final MobileRuntime _runtime;

  final Map<String, SipAccountConfig> _accounts = {};
  final Map<String, SipRegistrationStatus> _registrationStatus = {};

  /// `callId -> hubId` for every call this service currently knows about — the isolation guard
  /// behind `answer`/`hangup`/mute/speaker: a stale or forged `callId` for a Home this service
  /// never registered a call for is rejected rather than blindly forwarded to the engine.
  final Map<String, String> _callHomes = {};

  /// CallKit/Android-ConnectionService UUID ↔ SupremeOS callId (§ CALLKIT) — pure identifiers,
  /// never a credential, never persisted beyond process lifetime.
  final Map<String, String> _platformCallIds = {};

  final _registrationController = StreamController<SipRegistrationStatus>.broadcast();
  late final StreamSubscription<SipRegistrationStatus> _engineRegistrationSub;
  late final StreamSubscription<SipCall> _engineCallSub;

  SipService(this._engine, this._runtime) {
    _engineRegistrationSub = _engine.registrationStatus.listen(_onRegistrationStatus);
    _engineCallSub = _engine.calls.listen(_onEngineCall, onError: (_) {});
  }

  Stream<SipRegistrationStatus> get registrationStatus => _registrationController.stream;
  SipRegistrationStatus? registrationStatusFor(String hubId) => _registrationStatus[hubId];

  /// §Phase13.6A — starts the underlying engine (`SipEngine.initialize`). Must be called once
  /// before the first `configureHome` (e.g. at app/runtime startup); safe to call again after
  /// [shutdown] (process resumed from background/kill). Any initialization failure (missing
  /// native SIP support, out-of-memory) propagates to the caller rather than being swallowed —
  /// there is no account to register yet for `SipService` to attribute the failure to.
  Future<void> initialize() => _engine.initialize();

  /// Unregisters every configured Home and stops the underlying engine (`SipEngine.stop`) —
  /// distinct from [dispose], which additionally closes this `SipService`'s own streams and
  /// cannot be undone. Use `shutdown` for "app going to background/being killed," [dispose] only
  /// for "this `SipService` instance itself is being torn down."
  Future<void> shutdown() async {
    for (final hubId in _accounts.keys.toList()) {
      await _engine.unregisterAccount(hubId);
    }
    _accounts.clear();
    _registrationStatus.clear();
    await _engine.stop();
  }

  /// Registers (or replaces) the Home's own SIP account config and starts registration.
  /// [credentials] is passed straight to the engine and never retained by this class (§SECURITY).
  Future<void> configureHome(SipAccountConfig config, SipCredentials credentials) async {
    _accounts[config.hubId] = config;
    await _engine.registerAccount(config, credentials);
  }

  Future<void> removeHome(String hubId) async {
    _accounts.remove(hubId);
    _registrationStatus.remove(hubId);
    await _engine.unregisterAccount(hubId);
  }

  void _onRegistrationStatus(SipRegistrationStatus status) {
    // §MALFORMED EVENT HANDLING — a status for a Home this service never configured is dropped,
    // never surfaced (a stale engine callback racing a `removeHome`, or a bug upstream).
    if (!_accounts.containsKey(status.hubId) &&
        status.state != SipRegistrationState.unregistered) {
      return;
    }
    if (status.state == SipRegistrationState.unregistered) {
      _registrationStatus.remove(status.hubId);
    } else {
      _registrationStatus[status.hubId] = status;
    }
    _registrationController.add(status);
  }

  void _onEngineCall(SipCall call) {
    final account = _accounts[call.hubId];
    if (account == null) return; // §ISOLATION — unconfigured Home, dropped, never surfaced.

    final callState = _mapCallState(call.state);
    if (callState == null) return; // unknown/future engine state — dropped, not thrown.

    final existing = _runtime.activeCall(call.callId);
    if (existing == null) {
      // A call must start as `CallState.incoming` (`MobileRuntime.ingestIncomingCall`'s own
      // contract) — an engine reporting anything else for an unknown callId is either a
      // duplicate/out-of-order INVITE retransmission or a malformed event; both are dropped
      // rather than crashing the runtime (§ DUPLICATE INVITE / MALFORMED SIP EVENT).
      if (callState != CallState.incoming) return;

      final doorStation = account.doorStationFor(call.remoteUri);
      _callHomes[call.callId] = call.hubId;
      _runtime.ingestIncomingCall(CallSession(
        callId: call.callId,
        hubId: call.hubId,
        projectId: account.projectId,
        media: CallMedia.voice,
        state: CallState.incoming,
        startedAt: DateTime.now(),
        doorStationId: doorStation?.doorStationId,
        doorStationLabel: doorStation?.label,
      ));
      return;
    }

    if (callState == existing.state) return; // duplicate event for the same state — no-op.
    try {
      _runtime.transitionCall(call.callId, callState);
    } on StateError {
      // Illegal transition per `MobileRuntime`'s own state machine (§ same duplicate/malformed
      // handling as above) — the engine sent something inconsistent; drop it rather than crash.
    }
    if (callState == CallState.ended || callState == CallState.failed) {
      _callHomes.remove(call.callId);
      _platformCallIds.removeWhere((_, callId) => callId == call.callId);
    }
  }

  CallState? _mapCallState(SipCallState state) => switch (state) {
        SipCallState.trying => CallState.incoming,
        SipCallState.ringing => CallState.ringing,
        SipCallState.connecting => CallState.connecting,
        SipCallState.active => CallState.connected,
        SipCallState.ending => CallState.ending,
        SipCallState.ended => CallState.ended,
        SipCallState.failed => CallState.failed,
      };

  /// §CALLKIT — associates a platform (CallKit/ConnectionService) call UUID with a SupremeOS
  /// `callId`. The platform UUID and callId are both plain identifiers; nothing sensitive ever
  /// enters this map.
  void mapPlatformCallId(String platformCallUuid, String callId) {
    if (!_callHomes.containsKey(callId)) return; // unknown call — never map a forged pairing.
    _platformCallIds[platformCallUuid] = callId;
  }

  String? callIdForPlatformUuid(String platformCallUuid) => _platformCallIds[platformCallUuid];

  bool _authorize(String callId) => _callHomes.containsKey(callId);

  Future<void> answer(String callId) async {
    if (!_authorize(callId)) return;
    await _engine.answer(callId);
  }

  Future<void> hangup(String callId) async {
    if (!_authorize(callId)) return;
    await _engine.hangup(callId);
  }

  Future<void> setMuted(String callId, bool muted) async {
    if (!_authorize(callId)) return;
    await _engine.setMuted(callId, muted);
  }

  Future<void> setSpeakerOn(String callId, bool on) async {
    if (!_authorize(callId)) return;
    await _engine.setSpeakerOn(callId, on);
  }

  Future<void> dispose() async {
    await _engineRegistrationSub.cancel();
    await _engineCallSub.cancel();
    await _registrationController.close();
  }
}
