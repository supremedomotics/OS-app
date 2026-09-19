import 'lifecycle.dart';
import 'mobile_runtime_platform.dart';

/// §Phase13.1 §4 — used wherever no real native runtime bridge exists to talk to: Flutter web
/// builds (there is no Android/iOS native layer to speak `com.supremeos/runtime` to — Touch
/// Panel and Mobile-on-web are both real, supported targets, not a fallback for a broken
/// platform) and the widget-test harness (which has no platform-channel implementation
/// registered either). Genuinely inert — never fabricates a lifecycle event, never claims a
/// process state it didn't observe.
class NoOpMobileRuntimePlatform implements MobileRuntimePlatform {
  @override
  Future<void> initialize() async {}

  @override
  Future<void> notifyUiLifecycleChanged(UiState state) async {}

  @override
  Future<NativeRuntimeStatus> requestRuntimeStatus() async => const NativeRuntimeStatus(
      processState: ProcessState.foreground, platformVersion: 'web/none');

  @override
  Stream<NativeRuntimeEvent> get events => const Stream.empty();

  @override
  Future<void> startBackgroundService() async {}

  @override
  Future<void> stopBackgroundService() async {}

  @override
  Future<void> dispose() async {}
}
