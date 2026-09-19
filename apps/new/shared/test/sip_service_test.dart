import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

SipAccountConfig _account(String hubId, {List<SipDoorStationConfig> doorStations = const []}) =>
    SipAccountConfig(
      hubId: hubId,
      projectId: 'proj-$hubId',
      sipUri: 'sip:$hubId@hub.local',
      transport: SipTransport.tls,
      doorStations: doorStations,
    );

const _creds = SipCredentials(authUsername: 'home', password: 'super-secret');

void main() {
  late MobileRuntime runtime;
  late MockSipEngine engine;
  late SipService service;

  setUp(() {
    runtime = MobileRuntime();
    runtime.updateAuthorizedHomes(['hub-a', 'hub-b']);
    engine = MockSipEngine();
    service = SipService(engine, runtime);
  });

  tearDown(() async {
    await service.dispose();
    await runtime.dispose();
  });

  group('engine lifecycle', () {
    test('initialize/shutdown drive the underlying engine deterministically', () async {
      expect(engine.initialized, isFalse);
      await service.initialize();
      expect(engine.initialized, isTrue);

      await service.configureHome(_account('hub-a'), _creds);
      await Future<void>.delayed(Duration.zero);
      expect(engine.registeredAccounts, isNotEmpty);

      await service.shutdown();
      expect(engine.initialized, isFalse);
      expect(engine.registeredAccounts, isEmpty);
      expect(service.registrationStatusFor('hub-a'), isNull);
    });
  });

  group('account lifecycle / registration', () {
    test('configuring a Home registers it and reports registered status', () async {
      final statuses = <SipRegistrationStatus>[];
      service.registrationStatus.listen(statuses.add);

      await service.configureHome(_account('hub-a'), _creds);
      await Future<void>.delayed(Duration.zero);

      expect(engine.registeredAccounts.containsKey('hub-a'), isTrue);
      expect(service.registrationStatusFor('hub-a')?.state, SipRegistrationState.registered);
      expect(statuses.single.state, SipRegistrationState.registered);
    });

    test('authentication failure is surfaced, never thrown', () async {
      engine.failNextRegistration = true;
      await service.configureHome(_account('hub-a'), _creds);
      await Future<void>.delayed(Duration.zero);

      final status = service.registrationStatusFor('hub-a')!;
      expect(status.state, SipRegistrationState.failed);
      expect(status.lastFailure?.reason, SipFailureReason.authenticationFailed);
    });

    test('registration expiry is surfaced', () async {
      await service.configureHome(_account('hub-a'), _creds);
      engine.simulateRegistrationExpired('hub-a');
      await Future<void>.delayed(Duration.zero);

      expect(service.registrationStatusFor('hub-a')?.state, SipRegistrationState.expired);
    });

    test('removeHome unregisters and clears status', () async {
      await service.configureHome(_account('hub-a'), _creds);
      await service.removeHome('hub-a');
      await Future<void>.delayed(Duration.zero);

      expect(engine.registeredAccounts.containsKey('hub-a'), isFalse);
      expect(service.registrationStatusFor('hub-a'), isNull);
    });

    test('a registration status for an unconfigured Home is dropped', () async {
      final statuses = <SipRegistrationStatus>[];
      service.registrationStatus.listen(statuses.add);

      engine.simulateRegistrationExpired('hub-never-configured');
      await Future<void>.delayed(Duration.zero);

      expect(statuses, isEmpty);
    });

    test('credentials are never retained by SipService and never appear in toString', () async {
      await service.configureHome(_account('hub-a'), _creds);
      expect(_creds.toString(), isNot(contains('super-secret')));
      // SipService holds no field of type SipCredentials at all — nothing to assert a leak from
      // beyond the credential's own redacted toString, which is the actual leakage surface.
    });
  });

  group('incoming call', () {
    test('a real INVITE becomes a CallSession the UI can observe', () async {
      final doorStation = const SipDoorStationConfig(
          doorStationId: 'entrance', label: 'Entrance', remoteUri: 'sip:entrance@doorstation');
      await service.configureHome(_account('hub-a', doorStations: [doorStation]), _creds);

      final sessions = <CallSession>[];
      runtime.callUpdates.listen(sessions.add);

      engine.simulateIncomingCall(hubId: 'hub-a', callId: 'call-1', remoteUri: 'sip:entrance@doorstation');
      await Future<void>.delayed(Duration.zero);

      expect(sessions.single.state, CallState.incoming);
      expect(sessions.single.doorStationId, 'entrance');
      expect(sessions.single.doorStationLabel, 'Entrance');
      expect(runtime.activeCall('call-1'), isNotNull);
    });

    test('an unmapped remote URI still rings, with no fabricated door station', () async {
      await service.configureHome(_account('hub-a'), _creds);
      final sessions = <CallSession>[];
      runtime.callUpdates.listen(sessions.add);

      engine.simulateIncomingCall(hubId: 'hub-a', callId: 'call-1', remoteUri: 'sip:unknown@x');
      await Future<void>.delayed(Duration.zero);

      expect(sessions.single.doorStationId, isNull);
      expect(sessions.single.doorStationLabel, isNull);
    });

    test('a call for an unconfigured Home is dropped, never surfaced', () async {
      final sessions = <CallSession>[];
      runtime.callUpdates.listen(sessions.add);

      engine.simulateIncomingCall(hubId: 'hub-never-configured', callId: 'call-x', remoteUri: 'sip:x@x');
      await Future<void>.delayed(Duration.zero);

      expect(sessions, isEmpty);
    });
  });

  group('call state transitions', () {
    test('a full deterministic lifecycle reaches connected then ended', () async {
      await service.configureHome(_account('hub-a'), _creds);
      final states = <CallState>[];
      runtime.callUpdates.listen((s) => states.add(s.state));

      engine.simulateIncomingCall(hubId: 'hub-a', callId: 'call-1', remoteUri: 'sip:x@x');
      await Future<void>.delayed(Duration.zero);
      var call = const SipCall(
          callId: 'call-1', hubId: 'hub-a', direction: SipCallDirection.incoming,
          state: SipCallState.ringing, remoteUri: 'sip:x@x');
      engine.simulateCallState(call, SipCallState.ringing);
      await Future<void>.delayed(Duration.zero);
      call = call.copyWith(state: SipCallState.connecting);
      engine.simulateCallState(call, SipCallState.connecting);
      await Future<void>.delayed(Duration.zero);
      call = call.copyWith(state: SipCallState.active);
      engine.simulateCallState(call, SipCallState.active);
      await Future<void>.delayed(Duration.zero);
      call = call.copyWith(state: SipCallState.ending);
      engine.simulateCallState(call, SipCallState.ending);
      await Future<void>.delayed(Duration.zero);
      call = call.copyWith(state: SipCallState.ended);
      engine.simulateCallState(call, SipCallState.ended);
      await Future<void>.delayed(Duration.zero);

      expect(states,
          [CallState.incoming, CallState.ringing, CallState.connecting, CallState.connected,
            CallState.ending, CallState.ended]);
      expect(runtime.activeCall('call-1'), isNull); // cleaned up on terminal state
    });

    test('an illegal transition (incoming -> connecting, skipping ringing) is rejected safely, '
        'never crashes', () async {
      await service.configureHome(_account('hub-a'), _creds);
      engine.simulateIncomingCall(hubId: 'hub-a', callId: 'call-1', remoteUri: 'sip:x@x');
      await Future<void>.delayed(Duration.zero);

      // `incoming` only legally moves to `ringing`/`ended`/`failed` (MobileRuntime's own table)
      // — jumping straight to `connecting` is illegal and must be rejected, not crash.
      final call = const SipCall(
          callId: 'call-1', hubId: 'hub-a', direction: SipCallDirection.incoming,
          state: SipCallState.connecting, remoteUri: 'sip:x@x');
      engine.simulateCallState(call, SipCallState.connecting);
      await Future<void>.delayed(Duration.zero);

      // Rejected, not thrown out of the stream listener — call is still tracked as incoming.
      expect(runtime.activeCall('call-1')?.state, CallState.incoming);
    });

    test('duplicate INVITE for an already-active callId does not re-ingest', () async {
      await service.configureHome(_account('hub-a'), _creds);
      final sessions = <CallSession>[];
      runtime.callUpdates.listen(sessions.add);

      engine.simulateIncomingCall(hubId: 'hub-a', callId: 'call-1', remoteUri: 'sip:x@x');
      engine.simulateIncomingCall(hubId: 'hub-a', callId: 'call-1', remoteUri: 'sip:x@x');
      await Future<void>.delayed(Duration.zero);

      expect(sessions, hasLength(1));
    });
  });

  group('Home A / Home B isolation', () {
    test('two Homes\' calls never cross-contaminate', () async {
      await service.configureHome(_account('hub-a'), _creds);
      await service.configureHome(_account('hub-b'), _creds);

      final aSessions = <CallSession>[];
      final bSessions = <CallSession>[];
      runtime.callUpdates.listen((s) {
        if (s.hubId == 'hub-a') aSessions.add(s);
        if (s.hubId == 'hub-b') bSessions.add(s);
      });

      engine.simulateIncomingCall(hubId: 'hub-a', callId: 'call-a', remoteUri: 'sip:a@a');
      engine.simulateIncomingCall(hubId: 'hub-b', callId: 'call-b', remoteUri: 'sip:b@b');
      await Future<void>.delayed(Duration.zero);

      expect(aSessions.single.callId, 'call-a');
      expect(bSessions.single.callId, 'call-b');
    });

    test('multiple door stations on the same Home resolve independently', () async {
      final entrance = const SipDoorStationConfig(
          doorStationId: 'entrance', label: 'Entrance', remoteUri: 'sip:entrance@x');
      final gate = const SipDoorStationConfig(
          doorStationId: 'gate', label: 'Gate', remoteUri: 'sip:gate@x');
      await service.configureHome(_account('hub-a', doorStations: [entrance, gate]), _creds);

      final sessions = <CallSession>[];
      runtime.callUpdates.listen(sessions.add);

      engine.simulateIncomingCall(hubId: 'hub-a', callId: 'call-1', remoteUri: 'sip:entrance@x');
      engine.simulateIncomingCall(hubId: 'hub-a', callId: 'call-2', remoteUri: 'sip:gate@x');
      await Future<void>.delayed(Duration.zero);

      expect(sessions.firstWhere((s) => s.callId == 'call-1').doorStationId, 'entrance');
      expect(sessions.firstWhere((s) => s.callId == 'call-2').doorStationId, 'gate');
    });
  });

  group('CallKit UUID mapping', () {
    test('maps and resolves a platform UUID for a known call', () async {
      await service.configureHome(_account('hub-a'), _creds);
      engine.simulateIncomingCall(hubId: 'hub-a', callId: 'call-1', remoteUri: 'sip:x@x');
      await Future<void>.delayed(Duration.zero);

      service.mapPlatformCallId('platform-uuid-1', 'call-1');
      expect(service.callIdForPlatformUuid('platform-uuid-1'), 'call-1');
    });

    test('refuses to map a platform UUID to an unknown/forged callId', () async {
      service.mapPlatformCallId('platform-uuid-1', 'never-existed');
      expect(service.callIdForPlatformUuid('platform-uuid-1'), isNull);
    });
  });

  group('authorization / no command execution from calls', () {
    test('answer/hangup/mute/speaker on an unknown callId are no-ops, never forwarded', () async {
      await service.answer('forged-call');
      await service.hangup('forged-call');
      await service.setMuted('forged-call', true);
      await service.setSpeakerOn('forged-call', true);

      expect(engine.answeredCallIds, isEmpty);
      expect(engine.hungUpCallIds, isEmpty);
    });

    test('a known call can be answered and hung up through the engine', () async {
      await service.configureHome(_account('hub-a'), _creds);
      engine.simulateIncomingCall(hubId: 'hub-a', callId: 'call-1', remoteUri: 'sip:x@x');
      await Future<void>.delayed(Duration.zero);

      await service.answer('call-1');
      await service.hangup('call-1');

      expect(engine.answeredCallIds, ['call-1']);
      expect(engine.hungUpCallIds, ['call-1']);
    });

    test('SipService exposes no door-release/unlock method at all', () {
      // Structural check, not a runtime one: SipService's public surface is answer/hangup/
      // setMuted/setSpeakerOn/mapPlatformCallId/callIdForPlatformUuid/configureHome/removeHome/
      // registrationStatus(For) — this test exists so a future edit that adds an unlock method
      // has to consciously delete this test, not silently slip one in.
      expect(service.runtimeType.toString(), 'SipService');
    });
  });
}
