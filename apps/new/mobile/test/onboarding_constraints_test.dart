import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_mobile_next/main.dart';
import 'package:supreme_mobile_next/features/onboarding/onboarding_tokens.dart';
import 'package:supreme_mobile_next/runtime/noop_runtime_platform.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

class _Empty implements HubDiscovery {
  @override
  Future<Uri?> discoverLan({Duration timeout = const Duration(seconds: 3)}) async => null;
  @override
  Future<List<DiscoveredHub>> discoverAllLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      const [];
}

/// Android lays the surface out at ~0 px before its real size arrives; onboarding must not produce
/// a negative constraint there (`Padding` of 2 × the 20 px gutter on a 9.8 px area was −30.2).
void main() {
  for (final size in const [Size(9.8, 600), Size(0, 0), Size(39, 300), Size(1, 1)]) {
    testWidgets('onboarding lays out at ${size.width}×${size.height} without error',
        (tester) async {
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      SharedPreferences.setMockInitialValues({});
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final c = ProviderContainer(overrides: [
        platformDiscoveryProvider.overrideWithValue(_Empty()),
        pushTokenSourceProvider.overrideWithValue(null),
        mobileRuntimePlatformProvider.overrideWithValue(NoOpMobileRuntimePlatform()),
        networkChangeListenerProvider.overrideWith((ref) {}),
      ]);
      addTearDown(c.dispose);
      await tester.pumpWidget(UncontrolledProviderScope(
          container: c, child: const SupremeMobileApp()));
      for (var i = 0; i < 4; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
        await tester.pump(const Duration(milliseconds: 300));
      }
      expect(tester.takeException(), isNull);
      addTearDown(() async => tester.pumpWidget(const SizedBox()));
    });
  }

  test('metrics are never negative, and valid sizes keep the Golden Master values', () {
    for (final w in <double>[0, 1, 9.8, 39, 40, 100]) {
      final m = GmMetrics(w, 0);
      expect(m.gutter, inInclusiveRange(0, w / 2));
      expect(m.panelHeight(0), greaterThanOrEqualTo(0));
      expect(m.panelHeight(50), greaterThanOrEqualTo(0));
    }
    expect(const GmMetrics(390, 844).gutter, 20);
    expect(const GmMetrics(1440, 900).gutter, closeTo(64, 0.001));
    expect(const GmMetrics(834, 1194).gutter, closeTo(37.53, 0.001));
  });
}
