import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_mobile_next/main.dart';
import 'package:supreme_mobile_next/runtime/noop_runtime_platform.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

/// The real app, wired to the simulated residence at the transport boundary and a manual clock, so
/// a test drives real state flows (command → device report → confirmed) deterministically.
class SimApp {
  final ManualScheduler clock = ManualScheduler();
  late final SimulatedResidence sim =
      SimulatedResidence(schedule: clock.schedule, now: clock.now);
  final int hour;
  SimApp({this.hour = 15});

  List<Override> get overrides => [
        simulatedResidenceProvider.overrideWithValue(sim),
        commandScheduleProvider.overrideWithValue(clock.schedule),
        residenceHourProvider.overrideWithValue(hour),
        // No OS in a widget test: these two would open platform channels that do not exist here.
        pushTokenSourceProvider.overrideWithValue(null),
        mobileRuntimePlatformProvider.overrideWithValue(NoOpMobileRuntimePlatform()),
        networkChangeListenerProvider.overrideWith((ref) {}),
      ];

  Future<void> pump(WidgetTester tester,
      {Size logical = const Size(390, 844), double dpr = 2}) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = logical * dpr;
    tester.view.devicePixelRatio = dpr;
    addTearDown(tester.view.reset);
    // Unmount, then let the app's own retry/backoff timers run out on the fake clock.
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 30));
    });
    await tester.pumpWidget(ProviderScope(
        overrides: overrides, child: const SupremeMobileApp()));
    await settle(tester);
  }

  /// Opens the Control layer from the bar and lets its 500 ms slide finish.
  Future<void> openControl(WidgetTester tester) async {
    await tester.tap(find.text('Control'));
    await settle(tester);
    await tester.pump(const Duration(milliseconds: 600));
  }

  /// Lets async reads land and advances simulated time; never waits on wall-clock timers.
  Future<void> settle(WidgetTester tester, [int ms = 0]) async {
    await tester.runAsync(() => clock.advance(Duration(milliseconds: ms)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }
}
