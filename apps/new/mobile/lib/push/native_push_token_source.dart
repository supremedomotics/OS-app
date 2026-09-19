import 'dart:async';

import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;
import 'package:flutter/services.dart';

import '../runtime/runtime_controller.dart';

/// §Phase13.2 §5/§6 — the real platform-neutral [PlatformPushTokenSource], speaking a
/// DEDICATED `com.supremeos/push` MethodChannel + `com.supremeos/push/events` EventChannel —
/// deliberately separate from Phase 13.1's `com.supremeos/runtime` channel (push token
/// lifecycle is its own concern, not general OS lifecycle; keeping them apart means a future
/// phase can evolve one without touching the other's wire format).
///
/// Native responsibilities (see `MainActivity.kt`/`AppDelegate.swift` for the real, minimal
/// implementations):
///   Android — initialize Firebase, obtain an FCM registration token, forward token
///     refresh events.
///   iOS — call `UIApplication.registerForRemoteNotifications()`, forward the raw APNs
///     device-token hex string and any refresh.
///
/// Neither native side runs any SupremeOS semantic logic — they only obtain/forward a token
/// string and forward a received push payload's `data` map. Parsing that payload into a
/// [HomeEvent] happens in Dart (`mapPushEnvelopeToHomeEvent`, `apps/new/shared`), never natively.
///
/// HONEST STATUS: this is REAL client-side plumbing against a REAL channel contract, but has
/// NEVER been exercised against a real device or a real Firebase/APNs project in this
/// environment (no `google-services.json`/APNs credentials exist here, and native Android/iOS
/// cannot be compiled on this machine — see Phase 13.1/13.2's own build-environment findings).
/// Classify as REAL IMPLEMENTATION / REAL-WORLD NATIVE BUILD ACCEPTANCE REQUIRED, never as
/// proven token delivery.
class NativePushTokenSource implements PlatformPushTokenSource {
  static const _methodChannel = MethodChannel('com.supremeos/push');
  static const _eventChannel = EventChannel('com.supremeos/push/events');

  final _refreshController = StreamController<String>.broadcast();
  final _pushReceivedController =
      StreamController<Map<String, dynamic>>.broadcast();
  StreamSubscription<dynamic>? _nativeEventsSub;
  bool _initialized = false;

  NativePushTokenSource() {
    _nativeEventsSub =
        _eventChannel.receiveBroadcastStream().listen(_onNativeEvent, onError: (_) {});
  }

  void _onNativeEvent(dynamic raw) {
    if (raw is! Map) return; // malformed frame — dropped, never crashes the bridge.
    switch (raw['type']) {
      case 'tokenRefreshed':
        final token = raw['token'];
        if (token is String && token.isNotEmpty) _refreshController.add(token);
      case 'pushReceived':
        // §Phase13.2 §5/§6 — forwarded only while native has a live engine to forward through
        // (see this class's own HONEST SCOPE LIMIT doc — a fully backgrounded/terminated app
        // is out of this phase's scope). `data` is whatever the native side received verbatim;
        // parsing/validation happens in Dart (`mapPushEnvelopeToHomeEvent`), never natively.
        final data = raw['data'];
        if (data is Map) {
          _pushReceivedController.add(Map<String, dynamic>.from(data));
        }
      default:
      // Unknown event type — dropped, not thrown, for forward/backward version-skew safety.
    }
  }

  @override
  Future<void> initialize() async {
    if (_initialized) return;
    try {
      await _methodChannel.invokeMethod<void>('initialize');
      _initialized = true;
    } on MissingPluginException {
      // No native implementation registered yet (unbuilt native side, or a test harness) —
      // an honest no-op, never a crash. `currentToken()` will simply return null.
    }
  }

  @override
  Future<String?> currentToken() async {
    try {
      return await _methodChannel.invokeMethod<String>('currentToken');
    } on MissingPluginException {
      return null;
    }
  }

  @override
  Stream<String> get onTokenRefresh => _refreshController.stream;

  @override
  Stream<Map<String, dynamic>> get onPushReceived => _pushReceivedController.stream;

  @override
  String get platform =>
      defaultTargetPlatform == TargetPlatform.iOS ? 'apns' : 'fcm';

  @override
  Future<void> dispose() async {
    await _nativeEventsSub?.cancel();
    await _refreshController.close();
    await _pushReceivedController.close();
  }
}
