import 'dart:async';

import 'package:flutter/services.dart';
import 'package:supreme_os_core/supreme_os_core.dart' show CallState;

import 'lifecycle.dart';
import 'mobile_runtime_platform.dart';

/// §Phase13.1 §4 — the real [MobileRuntimePlatform] implementation, speaking the
/// `com.supremeos/runtime` MethodChannel (Flutter → Native calls) and
/// `com.supremeos/runtime/events` EventChannel (Native → Flutter events) this phase
/// establishes as the stable contract. Native sides: `MainActivity.kt` (Android),
/// `AppDelegate.swift` (iOS) — both register these same two channel names.
///
/// Wire format (the ONLY place this shape is interpreted, matching [lifecycle.dart]'s
/// single-parser convention):
///   MethodChannel calls: `initialize()`, `notifyUiLifecycleChanged({state: "uiActive"})`,
///     `requestRuntimeStatus()` -> `{processState: "foreground", platformVersion: "..."}`.
///   EventChannel frames: `{type: "processStateChanged", state: "background"}`. An unknown
///     `type` is dropped, not thrown (§ malformed-frame handling precedent set by
///     `HomeEventMapper`/`WebSocketHubEventStream` in Phase 12) — a future native build sending
///     an event type this Dart build doesn't know about yet must never crash the app.
class NativeRuntimeBridge implements MobileRuntimePlatform {
  static const _methodChannel = MethodChannel('com.supremeos/runtime');
  static const _eventChannel = EventChannel('com.supremeos/runtime/events');

  final _eventsController = StreamController<NativeRuntimeEvent>.broadcast();
  StreamSubscription<dynamic>? _nativeEventsSub;

  NativeRuntimeBridge() {
    _nativeEventsSub = _eventChannel
        .receiveBroadcastStream()
        .listen(_onNativeEvent, onError: (_) {});
  }

  void _onNativeEvent(dynamic raw) {
    if (raw is! Map) return; // malformed frame — dropped, never crashes the bridge.
    final type = raw['type'];
    switch (type) {
      case 'processStateChanged':
        final rawState = raw['state'];
        if (rawState is! String) return;
        try {
          _eventsController.add(ProcessStateChanged(parseProcessState(rawState)));
        } on ArgumentError {
          // Unknown state string — a version-skew case (older Flutter build, newer native
          // build), dropped rather than thrown, per this class's own doc.
        }
      case 'serviceStateChanged':
        final rawState = raw['state'];
        if (rawState is! String) return;
        try {
          _eventsController.add(ServiceStateChanged(parseAndroidServiceState(rawState)));
        } on ArgumentError {
          // Same version-skew tolerance as processStateChanged above.
        }
      case 'voipTokenRefreshed':
        final token = raw['token'];
        if (token is String) _eventsController.add(VoipTokenRefreshed(token));
      case 'incomingCall':
        final callId = raw['callId'];
        final hubId = raw['hubId'];
        if (callId is String && hubId is String) {
          _eventsController.add(IncomingCallEvent(callId: callId, hubId: hubId));
        }
      case 'incomingCallFailed':
        final callId = raw['callId'];
        final reason = raw['reason'];
        if (callId is String) {
          _eventsController
              .add(IncomingCallFailed(callId: callId, reason: reason is String ? reason : ''));
        }
      case 'callStateChanged':
        final callId = raw['callId'];
        final hubId = raw['hubId'];
        final rawState = raw['state'];
        if (callId is! String || hubId is! String || rawState is! String) return;
        final state = switch (rawState) {
          'idle' => CallState.idle,
          'incoming' => CallState.incoming,
          'ringing' => CallState.ringing,
          'connecting' => CallState.connecting,
          'connected' => CallState.connected,
          'ending' => CallState.ending,
          'ended' => CallState.ended,
          'failed' => CallState.failed,
          _ => null,
        };
        if (state != null) {
          _eventsController
              .add(CallStateChangedFromNative(callId: callId, hubId: hubId, state: state));
        }
      default:
      // Unknown event type — reserved for 13.4+'s call/notification events; dropped, not
      // thrown, until this Dart build actually knows how to decode them.
    }
  }

  @override
  Future<void> initialize() async {
    try {
      await _methodChannel.invokeMethod<void>('initialize');
    } on MissingPluginException {
      // No native implementation registered for this build/target yet — e.g. a version of the
      // app whose native side hasn't caught up, or a test harness. Never crash the app over a
      // diagnostics/lifecycle channel; the runtime itself is unaffected (§7).
    }
  }

  @override
  Future<void> notifyUiLifecycleChanged(UiState state) async {
    try {
      await _methodChannel.invokeMethod<void>(
          'notifyUiLifecycleChanged', {'state': state.name});
    } on MissingPluginException {
      // See initialize()'s doc.
    }
  }

  @override
  Future<NativeRuntimeStatus> requestRuntimeStatus() async {
    try {
      final result = await _methodChannel
          .invokeMethod<Map<dynamic, dynamic>>('requestRuntimeStatus');
      final map = result ?? const {};
      final rawState = map['processState'] as String?;
      return NativeRuntimeStatus(
        processState: rawState != null
            ? parseProcessState(rawState)
            : ProcessState.foreground,
        platformVersion: map['platformVersion'] as String? ?? 'unknown',
      );
    } on MissingPluginException {
      // See initialize()'s doc — an honest "unknown" rather than a crash.
      return const NativeRuntimeStatus(
          processState: ProcessState.foreground, platformVersion: 'unknown');
    }
  }

  @override
  Stream<NativeRuntimeEvent> get events => _eventsController.stream;

  @override
  Future<void> startBackgroundService() async {
    try {
      await _methodChannel.invokeMethod<void>('startBackgroundService');
    } on MissingPluginException {
      // No native implementation for this method (e.g. iOS, or an unbuilt/older Android build)
      // — an honest no-op, never a crash. See NoOpMobileRuntimePlatform's own doc.
    }
  }

  @override
  Future<void> stopBackgroundService() async {
    try {
      await _methodChannel.invokeMethod<void>('stopBackgroundService');
    } on MissingPluginException {
      // See startBackgroundService()'s doc.
    }
  }

  @override
  Future<void> dispose() async {
    await _nativeEventsSub?.cancel();
    await _eventsController.close();
  }
}
