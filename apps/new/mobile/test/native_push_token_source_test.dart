import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:supreme_mobile_next/push/native_push_token_source.dart';

/// §Phase13.2 §14 — proves [NativePushTokenSource] behaves correctly against the test harness's
/// own channel mock (no real Android/iOS platform implementation exists to talk to here — see
/// the class's own HONEST STATUS doc). This is a REAL unit test of REAL Dart code; it is NOT a
/// substitute for a real-device test and must not be reported as one.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const methodChannel = MethodChannel('com.supremeos/push');
  const eventChannel = EventChannel('com.supremeos/push/events');

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(methodChannel, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockStreamHandler(eventChannel, null);
  });

  group(
      'NativePushTokenSource — with NO native implementation registered (this environment\'s real state)',
      () {
    test('initialize()/currentToken() degrade honestly instead of throwing', () async {
      final source = NativePushTokenSource();
      await source.initialize(); // MissingPluginException caught internally
      final token = await source.currentToken();
      expect(token, isNull);
      await source.dispose();
    });

    test('platform reports "fcm" or "apns" per the real defaultTargetPlatform', () {
      final source = NativePushTokenSource();
      expect(['fcm', 'apns'], contains(source.platform));
    });
  });

  group('NativePushTokenSource — with a MOCK native implementation', () {
    test('initialize() calls the real method channel when a handler exists', () async {
      var initializeCalled = false;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(methodChannel, (call) async {
        if (call.method == 'initialize') {
          initializeCalled = true;
          return null;
        }
        if (call.method == 'currentToken') return 'fake-fcm-token-123';
        return null;
      });

      final source = NativePushTokenSource();
      await source.initialize();
      final token = await source.currentToken();

      expect(initializeCalled, isTrue);
      expect(token, 'fake-fcm-token-123');
      await source.dispose();
    });

    test('a tokenRefreshed native event surfaces on onTokenRefresh', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(
          onListen: (arguments, events) {
            events.success({'type': 'tokenRefreshed', 'token': 'new-token'});
          },
        ),
      );

      final source = NativePushTokenSource();
      final refreshed = await source.onTokenRefresh.first;
      expect(refreshed, 'new-token');
      await source.dispose();
    });

    test('a malformed native event is dropped, never crashes the stream', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
        eventChannel,
        MockStreamHandler.inline(
          onListen: (arguments, events) {
            events.success('not a map'); // malformed
            events.success({'type': 'tokenRefreshed', 'token': 'good-token'});
          },
        ),
      );

      final source = NativePushTokenSource();
      final refreshed = await source.onTokenRefresh.first;
      expect(refreshed, 'good-token'); // the malformed frame was dropped, not a crash
      await source.dispose();
    });
  });
}
