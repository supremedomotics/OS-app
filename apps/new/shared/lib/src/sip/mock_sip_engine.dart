import 'dart:async';

import 'sip_account.dart';
import 'sip_call.dart';
import 'sip_domain.dart';
import 'sip_engine.dart';

/// A deterministic, in-process `SipEngine` for tests and pre-native-binding development — the
/// same role `MockHubTransport`/`InMemoryPairedHomeStore` already play elsewhere in this package.
/// NEVER a production engine (see its own file's doc and the Phase 13.5 final report's
/// classification matrix): it does no real SIP signaling, RTP, or network I/O at all. Tests drive
/// it explicitly (`simulateRegistered`, `simulateIncomingCall`, ...) rather than it doing anything
/// on its own, so a test's assertions are about `SipService`'s logic, never about timing.
class MockSipEngine implements SipEngine {
  final _registrationController = StreamController<SipRegistrationStatus>.broadcast();
  final _callsController = StreamController<SipCall>.broadcast();

  final Map<String, SipAccountConfig> registeredAccounts = {};
  final List<String> answeredCallIds = [];
  final List<String> hungUpCallIds = [];

  bool failNextRegistration = false;
  bool initialized = false;

  @override
  Stream<SipRegistrationStatus> get registrationStatus => _registrationController.stream;

  @override
  Stream<SipCall> get calls => _callsController.stream;

  @override
  Future<void> initialize() async {
    initialized = true;
  }

  @override
  Future<void> stop() async {
    initialized = false;
    registeredAccounts.clear();
  }

  @override
  Future<void> registerAccount(SipAccountConfig config, SipCredentials credentials) async {
    if (failNextRegistration) {
      failNextRegistration = false;
      _registrationController.add(SipRegistrationStatus(
        hubId: config.hubId,
        state: SipRegistrationState.failed,
        lastFailure: const SipFailure(
            SipFailureReason.authenticationFailed, 'mock: forced failure'),
      ));
      return;
    }
    registeredAccounts[config.hubId] = config;
    _registrationController.add(SipRegistrationStatus(
      hubId: config.hubId,
      state: SipRegistrationState.registered,
      expiresAt: DateTime.now().add(const Duration(hours: 1)),
    ));
  }

  @override
  Future<void> unregisterAccount(String hubId) async {
    registeredAccounts.remove(hubId);
    _registrationController.add(
        SipRegistrationStatus(hubId: hubId, state: SipRegistrationState.unregistered));
  }

  /// Test hook — simulates a door station's INVITE arriving for [hubId] from [remoteUri].
  void simulateIncomingCall({
    required String hubId,
    required String callId,
    required String remoteUri,
  }) {
    _callsController.add(SipCall(
      callId: callId,
      hubId: hubId,
      direction: SipCallDirection.incoming,
      state: SipCallState.trying,
      remoteUri: remoteUri,
    ));
  }

  /// Test hook — advances an already-known call to a new engine-level state.
  void simulateCallState(SipCall current, SipCallState next) {
    _callsController.add(current.copyWith(state: next));
  }

  void simulateRegistrationExpired(String hubId) {
    _registrationController.add(
        SipRegistrationStatus(hubId: hubId, state: SipRegistrationState.expired));
  }

  @override
  Future<void> answer(String callId) async {
    answeredCallIds.add(callId);
  }

  @override
  Future<void> hangup(String callId) async {
    hungUpCallIds.add(callId);
  }

  @override
  Future<void> setMuted(String callId, bool muted) async {}

  @override
  Future<void> setSpeakerOn(String callId, bool on) async {}

  @override
  Future<void> dispose() async {
    await _registrationController.close();
    await _callsController.close();
  }
}
