import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_mobile_next/runtime/lifecycle.dart';
import 'package:supreme_mobile_next/runtime/mobile_runtime_platform.dart';
import 'package:supreme_mobile_next/runtime/noop_runtime_platform.dart';

/// §Phase13.1 §14 — a fake [MobileRuntimePlatform] proves the CONTRACT (interface shape,
/// extensibility) without a real platform channel, which cannot be exercised outside a real
/// Android/iOS build (§14: "do not count uncompiled Kotlin/Swift as tested").
class _FakePlatform implements MobileRuntimePlatform {
  final _controller = Stream<NativeRuntimeEvent>.empty();
  UiState? lastReportedUiState;
  bool initialized = false;

  @override
  Future<void> initialize() async {
    initialized = true;
  }

  @override
  Future<void> notifyUiLifecycleChanged(UiState state) async {
    lastReportedUiState = state;
  }

  @override
  Future<NativeRuntimeStatus> requestRuntimeStatus() async => const NativeRuntimeStatus(
      processState: ProcessState.foreground, platformVersion: 'fake-1.0');

  @override
  Stream<NativeRuntimeEvent> get events => _controller;

  bool backgroundServiceStarted = false;

  @override
  Future<void> startBackgroundService() async {
    backgroundServiceStarted = true;
  }

  @override
  Future<void> stopBackgroundService() async {
    backgroundServiceStarted = false;
  }

  @override
  Future<void> dispose() async {}
}

void main() {
  group('MobileRuntimePlatform contract (§Phase13.1 §13)', () {
    test('a fake implementation satisfies the interface without any platform channel',
        () async {
      final platform = _FakePlatform();
      await platform.initialize();
      await platform.notifyUiLifecycleChanged(UiState.uiActive);
      final status = await platform.requestRuntimeStatus();

      expect(platform.initialized, isTrue);
      expect(platform.lastReportedUiState, UiState.uiActive);
      expect(status.processState, ProcessState.foreground);
    });

    test(
        'NativeRuntimeEvent is a sealed hierarchy — a switch must handle every known subtype',
        () {
      String describe(NativeRuntimeEvent event) => switch (event) {
            ProcessStateChanged(:final state) => 'process:${state.name}',
            ServiceStateChanged(:final state) => 'service:${state.name}',
            VoipTokenRefreshed() => 'voipToken',
            IncomingCallEvent() => 'incomingCall',
            CallStateChangedFromNative() => 'callState',
            IncomingCallFailed() => 'incomingCallFailed',
          };
      expect(describe(const ProcessStateChanged(ProcessState.background)),
          'process:background');
      expect(describe(const ServiceStateChanged(AndroidServiceState.running)),
          'service:running');
    });
  });

  group('NoOpMobileRuntimePlatform (§Phase13.1 §4 — web/test target)', () {
    test('never fabricates a lifecycle event and reports an honest default status', () async {
      final platform = NoOpMobileRuntimePlatform();
      final status = await platform.requestRuntimeStatus();

      expect(status.processState, ProcessState.foreground);
      expect(status.platformVersion, 'web/none');
      expect(await platform.events.isEmpty, isTrue);

      // None of these should throw — the whole point of a no-op is to be safely inert.
      await platform.initialize();
      await platform.notifyUiLifecycleChanged(UiState.uiBackgrounded);
      await platform.startBackgroundService();
      await platform.stopBackgroundService();
      await platform.dispose();
    });
  });
}
