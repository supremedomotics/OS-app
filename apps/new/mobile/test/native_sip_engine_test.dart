import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:supreme_mobile_next/sip/native_sip_engine.dart';

/// §Phase13.6 §14 — proves [NativeSipEngine]'s wire-format contract against the test harness's
/// own channel mock. No real native (Kotlin/Swift/pjsua2) implementation exists to talk to here —
/// this is a REAL unit test of REAL Dart code, NOT a substitute for real-device SIP acceptance
/// (see `docs/architecture/PHASE_13_6_FINAL_REPORT.md`'s classification matrix).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const methodChannel = MethodChannel('com.supremeos/sip');
  const eventChannel = EventChannel('com.supremeos/sip/events');

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(methodChannel, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockStreamHandler(eventChannel, null);
  });

  group('NativeSipEngine — with NO native implementation registered', () {
    test('every method degrades honestly instead of throwing', () async {
      final engine = NativeSipEngine();
      await engine.initialize();
      await engine.stop();
      await engine.registerAccount(
        const SipAccountConfig(
            hubId: 'hub-a', projectId: 'proj-a', sipUri: 'sip:a@hub', transport: SipTransport.tls),
        const SipCredentials(authUsername: 'a', password: 'secret'),
      );
      await engine.unregisterAccount('hub-a');
      await engine.answer('call-1');
      await engine.hangup('call-1');
      await engine.setMuted('call-1', true);
      await engine.setSpeakerOn('call-1', true);
      await engine.dispose();
    });
  });

  group('NativeSipEngine — with a MOCK native implementation', () {
    test('registerAccount sends the full config, never a bare hubId', () async {
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(methodChannel, (call) async {
        calls.add(call);
        return null;
      });

      final engine = NativeSipEngine();
      final doorStation = const SipDoorStationConfig(
          doorStationId: 'entrance', label: 'Entrance', remoteUri: 'sip:entrance@x');
      await engine.registerAccount(
        SipAccountConfig(
          hubId: 'hub-a',
          projectId: 'proj-a',
          sipUri: 'sip:a@hub',
          transport: SipTransport.tls,
          doorStations: [doorStation],
        ),
        const SipCredentials(authUsername: 'a', password: 'super-secret'),
      );

      expect(calls.single.method, 'registerAccount');
      final args = calls.single.arguments as Map;
      expect(args['hubId'], 'hub-a');
      expect(args['transport'], 'tls');
      expect(args['password'], 'super-secret'); // sent once, over the channel, never logged
      expect((args['doorStations'] as List).single, {
        'doorStationId': 'entrance',
        'label': 'Entrance',
        'remoteUri': 'sip:entrance@x',
      });
      await engine.dispose();
    });

    test('initialize/stop/answer/hangup/setMuted/setSpeakerOn call the real method channel',
        () async {
      final calls = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(methodChannel, (call) async {
        calls.add(call.method);
        return null;
      });

      final engine = NativeSipEngine();
      await engine.initialize();
      await engine.answer('call-1');
      await engine.hangup('call-1');
      await engine.setMuted('call-1', true);
      await engine.setSpeakerOn('call-1', true);
      await engine.stop();

      expect(calls, ['initialize', 'answer', 'hangup', 'setMuted', 'setSpeakerOn', 'stop']);
      await engine.dispose();
    });

    test('a registrationStatus event surfaces as SipRegistrationStatus', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(onListen: (arguments, events) {
          events.success({
            'type': 'registrationStatus',
            'hubId': 'hub-a',
            'state': 'registered',
            'expiresAt': DateTime(2026).toIso8601String(),
          });
        }),
      );

      final engine = NativeSipEngine();
      final status = await engine.registrationStatus.first;
      expect(status.hubId, 'hub-a');
      expect(status.state, SipRegistrationState.registered);
      await engine.dispose();
    });

    test('a registrationStatus failure event carries a homeowner-safe reason, never raw detail'
        ' leaking a credential', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(onListen: (arguments, events) {
          events.success({
            'type': 'registrationStatus',
            'hubId': 'hub-a',
            'state': 'failed',
            'failureReason': 'authenticationFailed',
            'failureDetail': '401 Unauthorized',
          });
        }),
      );

      final engine = NativeSipEngine();
      final status = await engine.registrationStatus.first;
      expect(status.state, SipRegistrationState.failed);
      expect(status.lastFailure?.reason, SipFailureReason.authenticationFailed);
      expect(status.lastFailure.toString(), isNot(contains('401')));
      await engine.dispose();
    });

    test('a call event surfaces as SipCall with codec and audio state', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(onListen: (arguments, events) {
          events.success({
            'type': 'call',
            'callId': 'call-1',
            'hubId': 'hub-a',
            'direction': 'incoming',
            'state': 'active',
            'remoteUri': 'sip:entrance@x',
            'codec': 'pcmu',
            'muted': true,
            'speakerOn': false,
          });
        }),
      );

      final engine = NativeSipEngine();
      final call = await engine.calls.first;
      expect(call.callId, 'call-1');
      expect(call.state, SipCallState.active);
      expect(call.negotiatedCodec, SipCodec.pcmu);
      expect(call.audio.microphoneMuted, isTrue);
      expect(call.audio.speakerOn, isFalse);
      await engine.dispose();
    });

    test('an unknown event type/state is dropped, never thrown', () async {
      final received = <SipCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(onListen: (arguments, events) {
          events.success({'type': 'somethingFutureVersionSends'});
          events.success({
            'type': 'call',
            'callId': 'call-1',
            'hubId': 'hub-a',
            'direction': 'incoming',
            'state': 'a-future-state-this-build-does-not-know',
            'remoteUri': 'sip:x@x',
          });
          events.success({
            'type': 'call',
            'callId': 'call-2',
            'hubId': 'hub-a',
            'direction': 'incoming',
            'state': 'trying',
            'remoteUri': 'sip:x@x',
          });
        }),
      );

      final engine = NativeSipEngine();
      engine.calls.listen(received.add);
      final call = await engine.calls.first;
      expect(call.callId, 'call-2'); // only the well-formed event surfaced
      await engine.dispose();
    });
  });
}
