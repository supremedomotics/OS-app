import 'dart:async';

import 'package:flutter/services.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// §Phase13.6 — the real `SipEngine` implementation, speaking a new, dedicated
/// `com.supremeos/sip` MethodChannel (Flutter → Native) and `com.supremeos/sip/events`
/// EventChannel (Native → Flutter), kept SEPARATE from `com.supremeos/runtime` per the phase
/// brief's own guidance ("a clearly versioned SIP-specific extension ... only if this produces a
/// cleaner architecture") — SIP registration/call lifecycle is a materially different concern
/// from process/UI lifecycle, and giving it its own channel keeps `NativeRuntimeBridge`'s wire
/// format from growing SIP-specific cases indefinitely.
///
/// HONEST STATUS: this class is REAL, tested Dart code implementing a REAL wire-format contract
/// — but no native Android (Kotlin/pjsua2) or iOS (Swift/pjsua2) implementation of the OTHER end
/// of this channel exists yet (`docs/architecture/PHASE_13_6_SIP_NATIVE_ARCHITECTURE.md`
/// documents exactly what that implementation must do). Every method degrades to a documented,
/// non-throwing no-op when no native handler is registered (`MissingPluginException`), exactly
/// like `NativeRuntimeBridge`'s own precedent — this is what lets this class exist and be tested
/// truthfully before the native side is built, without ever pretending a call is being placed.
///
/// Never leaks a pjsua/pjsua2/pjmedia/pjlib type — the wire format below is the ONLY place native
/// SIP concepts are touched, translated immediately into `sip_domain.dart`/`sip_account.dart`/
/// `sip_call.dart` types.
class NativeSipEngine implements SipEngine {
  static const _methodChannel = MethodChannel('com.supremeos/sip');
  static const _eventChannel = EventChannel('com.supremeos/sip/events');

  final _registrationController = StreamController<SipRegistrationStatus>.broadcast();
  final _callsController = StreamController<SipCall>.broadcast();
  StreamSubscription<dynamic>? _nativeEventsSub;

  NativeSipEngine() {
    _nativeEventsSub =
        _eventChannel.receiveBroadcastStream().listen(_onNativeEvent, onError: (_) {});
  }

  void _onNativeEvent(dynamic raw) {
    if (raw is! Map) return; // malformed frame — dropped, never crashes (§ same precedent as
    // NativeRuntimeBridge/HomeEventMapper/WebSocketHubEventStream).
    final type = raw['type'];
    switch (type) {
      case 'registrationStatus':
        final status = _parseRegistrationStatus(raw);
        if (status != null) _registrationController.add(status);
      case 'call':
        final call = _parseCall(raw);
        if (call != null) _callsController.add(call);
      default:
      // Unknown/future event type — dropped, not thrown, per this codebase's version-skew
      // tolerance convention.
    }
  }

  SipRegistrationStatus? _parseRegistrationStatus(Map raw) {
    final hubId = raw['hubId'];
    final rawState = raw['state'];
    if (hubId is! String || rawState is! String) return null;
    final state = switch (rawState) {
      'unregistered' => SipRegistrationState.unregistered,
      'registering' => SipRegistrationState.registering,
      'registered' => SipRegistrationState.registered,
      'failed' => SipRegistrationState.failed,
      'expired' => SipRegistrationState.expired,
      _ => null,
    };
    if (state == null) return null;
    final expiresAtRaw = raw['expiresAt'];
    final failureReason = _parseFailureReason(raw['failureReason']);
    return SipRegistrationStatus(
      hubId: hubId,
      state: state,
      expiresAt: expiresAtRaw is String ? DateTime.tryParse(expiresAtRaw) : null,
      lastFailure: failureReason == null
          ? null
          : SipFailure(failureReason, (raw['failureDetail'] as String?) ?? ''),
    );
  }

  SipCall? _parseCall(Map raw) {
    final callId = raw['callId'];
    final hubId = raw['hubId'];
    final rawDirection = raw['direction'];
    final rawState = raw['state'];
    final remoteUri = raw['remoteUri'];
    if (callId is! String ||
        hubId is! String ||
        rawDirection is! String ||
        rawState is! String ||
        remoteUri is! String) {
      return null;
    }
    final direction = switch (rawDirection) {
      'incoming' => SipCallDirection.incoming,
      'outgoing' => SipCallDirection.outgoing,
      _ => null,
    };
    final state = switch (rawState) {
      'trying' => SipCallState.trying,
      'ringing' => SipCallState.ringing,
      'connecting' => SipCallState.connecting,
      'active' => SipCallState.active,
      'ending' => SipCallState.ending,
      'ended' => SipCallState.ended,
      'failed' => SipCallState.failed,
      _ => null,
    };
    if (direction == null || state == null) return null;
    final failureReason = _parseFailureReason(raw['failureReason']);
    return SipCall(
      callId: callId,
      hubId: hubId,
      direction: direction,
      state: state,
      remoteUri: remoteUri,
      negotiatedCodec: _parseCodec(raw['codec']),
      audio: SipAudioState(
        microphoneMuted: raw['muted'] == true,
        speakerOn: raw['speakerOn'] == true,
      ),
      failure: failureReason == null
          ? null
          : SipFailure(failureReason, (raw['failureDetail'] as String?) ?? ''),
    );
  }

  SipFailureReason? _parseFailureReason(dynamic raw) => switch (raw) {
        'registrationFailed' => SipFailureReason.registrationFailed,
        'authenticationFailed' => SipFailureReason.authenticationFailed,
        'network' => SipFailureReason.network,
        'timeout' => SipFailureReason.timeout,
        'rejected' => SipFailureReason.rejected,
        'unknown' => SipFailureReason.unknown,
        _ => null,
      };

  SipCodec? _parseCodec(dynamic raw) => switch (raw) {
        'pcmu' => SipCodec.pcmu,
        'pcma' => SipCodec.pcma,
        'g722' => SipCodec.g722,
        'opus' => SipCodec.opus,
        _ => null,
      };

  @override
  Stream<SipRegistrationStatus> get registrationStatus => _registrationController.stream;

  @override
  Stream<SipCall> get calls => _callsController.stream;

  @override
  Future<void> initialize() async {
    try {
      await _methodChannel.invokeMethod<void>('initialize');
    } on MissingPluginException {
      // No native SIP implementation registered for this build (§Phase13.6 HONEST STATUS above)
      // — an honest no-op. Unlike `registerAccount`, a real native failure here is NOT swallowed
      // (see `SipEngine.initialize`'s own doc) — only the "no native module exists at all" case
      // degrades quietly, matching every other method's precedent.
    }
  }

  @override
  Future<void> stop() async {
    try {
      await _methodChannel.invokeMethod<void>('stop');
    } on MissingPluginException {
      // See initialize()'s doc.
    }
  }

  @override
  Future<void> registerAccount(SipAccountConfig config, SipCredentials credentials) async {
    try {
      await _methodChannel.invokeMethod<void>('registerAccount', {
        'hubId': config.hubId,
        'projectId': config.projectId,
        'sipUri': config.sipUri,
        'transport': config.transport.name,
        'authUsername': credentials.authUsername,
        'password': credentials.password,
        'doorStations': [
          for (final d in config.doorStations)
            {'doorStationId': d.doorStationId, 'label': d.label, 'remoteUri': d.remoteUri},
        ],
      });
    } on MissingPluginException {
      // No native SIP implementation registered for this build (§Phase13.6 HONEST STATUS above)
      // — an honest no-op. The caller (`SipService`) is not told registration succeeded; no
      // registrationStatus event is emitted, so `SipService` correctly reflects "nothing has
      // happened yet" rather than a fabricated success.
    }
  }

  @override
  Future<void> unregisterAccount(String hubId) async {
    try {
      await _methodChannel.invokeMethod<void>('unregisterAccount', {'hubId': hubId});
    } on MissingPluginException {
      // See registerAccount()'s doc.
    }
  }

  @override
  Future<void> answer(String callId) async {
    try {
      await _methodChannel.invokeMethod<void>('answer', {'callId': callId});
    } on MissingPluginException {
      // See registerAccount()'s doc.
    }
  }

  @override
  Future<void> hangup(String callId) async {
    try {
      await _methodChannel.invokeMethod<void>('hangup', {'callId': callId});
    } on MissingPluginException {
      // See registerAccount()'s doc.
    }
  }

  @override
  Future<void> setMuted(String callId, bool muted) async {
    try {
      await _methodChannel.invokeMethod<void>('setMuted', {'callId': callId, 'muted': muted});
    } on MissingPluginException {
      // See registerAccount()'s doc.
    }
  }

  @override
  Future<void> setSpeakerOn(String callId, bool on) async {
    try {
      await _methodChannel.invokeMethod<void>('setSpeakerOn', {'callId': callId, 'on': on});
    } on MissingPluginException {
      // See registerAccount()'s doc.
    }
  }

  @override
  Future<void> dispose() async {
    await _nativeEventsSub?.cancel();
    await _registrationController.close();
    await _callsController.close();
  }
}
