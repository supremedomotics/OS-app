import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:supreme_os_core/supreme_os_core.dart' show CallState;
import 'package:supreme_mobile_next/runtime/lifecycle.dart';
import 'package:supreme_mobile_next/runtime/mobile_runtime_platform.dart';
import 'package:supreme_mobile_next/runtime/native_runtime_bridge.dart';

/// §Phase13.3 §14 — proves [NativeRuntimeBridge]'s wire-format contract against the test
/// harness's own channel mock (no real Android implementation exists to talk to here). A REAL
/// unit test of REAL Dart code — NOT a substitute for a real-device test.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const methodChannel = MethodChannel('com.supremeos/runtime');
  const eventChannel = EventChannel('com.supremeos/runtime/events');

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(methodChannel, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockStreamHandler(eventChannel, null);
  });

  group('NativeRuntimeBridge — with NO native implementation registered', () {
    test('startBackgroundService()/stopBackgroundService() degrade honestly instead of throwing',
        () async {
      final bridge = NativeRuntimeBridge();
      await bridge.startBackgroundService();
      await bridge.stopBackgroundService();
      await bridge.dispose();
    });
  });

  group('NativeRuntimeBridge — with a MOCK native implementation (§Phase13.3)', () {
    test('startBackgroundService()/stopBackgroundService() call the real method channel',
        () async {
      final calls = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(methodChannel, (call) async {
        calls.add(call.method);
        return null;
      });

      final bridge = NativeRuntimeBridge();
      await bridge.startBackgroundService();
      await bridge.stopBackgroundService();

      expect(calls, ['startBackgroundService', 'stopBackgroundService']);
      await bridge.dispose();
    });

    test('a serviceStateChanged native event surfaces as ServiceStateChanged', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(
          onListen: (arguments, events) {
            events.success({'type': 'serviceStateChanged', 'state': 'running'});
          },
        ),
      );

      final bridge = NativeRuntimeBridge();
      final event = await bridge.events.first;
      expect(event, isA<ServiceStateChanged>());
      expect((event as ServiceStateChanged).state, AndroidServiceState.running);
      await bridge.dispose();
    });

    test('an unknown serviceStateChanged state string is dropped, not thrown', () async {
      final received = <NativeRuntimeEvent>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(
          onListen: (arguments, events) {
            events.success({'type': 'serviceStateChanged', 'state': 'exploding'});
            events.success({'type': 'serviceStateChanged', 'state': 'running'});
          },
        ),
      );

      final bridge = NativeRuntimeBridge();
      final sub = bridge.events.listen(received.add);
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(received, hasLength(1)); // the malformed one was dropped
      expect((received.single as ServiceStateChanged).state, AndroidServiceState.running);
      await sub.cancel();
      await bridge.dispose();
    });
  });

  group('§Phase13.4 — VoIP/CallKit event parsing (iOS foundation)', () {
    test('a real incomingCall frame surfaces as IncomingCallEvent', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(
          onListen: (arguments, events) {
            events.success({'type': 'incomingCall', 'callId': 'call-1', 'hubId': 'hub-a'});
          },
        ),
      );

      final bridge = NativeRuntimeBridge();
      final event = await bridge.events.first;
      expect(event, isA<IncomingCallEvent>());
      expect((event as IncomingCallEvent).callId, 'call-1');
      expect(event.hubId, 'hub-a');
      await bridge.dispose();
    });

    test('an incomingCall frame missing hubId is dropped, never surfaced (VoIP envelope validation)',
        () async {
      final received = <NativeRuntimeEvent>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(
          onListen: (arguments, events) {
            events.success({'type': 'incomingCall', 'callId': 'call-1'}); // no hubId
            events.success({'type': 'incomingCall', 'callId': 'call-2', 'hubId': 'hub-a'});
          },
        ),
      );

      final bridge = NativeRuntimeBridge();
      final sub = bridge.events.listen(received.add);
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(received, hasLength(1));
      expect((received.single as IncomingCallEvent).callId, 'call-2');
      await sub.cancel();
      await bridge.dispose();
    });

    test('a real callStateChanged frame surfaces as CallStateChangedFromNative', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(
          onListen: (arguments, events) {
            events.success({
              'type': 'callStateChanged',
              'callId': 'call-1',
              'hubId': 'hub-a',
              'state': 'connecting',
            });
          },
        ),
      );

      final bridge = NativeRuntimeBridge();
      final event = await bridge.events.first;
      expect(event, isA<CallStateChangedFromNative>());
      expect((event as CallStateChangedFromNative).state, CallState.connecting);
      await bridge.dispose();
    });

    test('a callStateChanged frame with an unrecognized state string is dropped, not thrown',
        () async {
      final received = <NativeRuntimeEvent>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(
          onListen: (arguments, events) {
            events.success({
              'type': 'callStateChanged',
              'callId': 'call-1',
              'hubId': 'hub-a',
              'state': 'levitating',
            });
          },
        ),
      );

      final bridge = NativeRuntimeBridge();
      final sub = bridge.events.listen(received.add);
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(received, isEmpty);
      await sub.cancel();
      await bridge.dispose();
    });

    test('a voipTokenRefreshed frame surfaces as VoipTokenRefreshed', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(
          onListen: (arguments, events) {
            events.success({'type': 'voipTokenRefreshed', 'token': 'voip-tok-123'});
          },
        ),
      );

      final bridge = NativeRuntimeBridge();
      final event = await bridge.events.first;
      expect(event, isA<VoipTokenRefreshed>());
      expect((event as VoipTokenRefreshed).token, 'voip-tok-123');
      await bridge.dispose();
    });
  });
}
