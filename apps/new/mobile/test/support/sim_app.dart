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

  /// False starts on the arrival flow (a simulation build before Demo is chosen); true starts past
  /// it, as a tap on Demo would.
  final bool pastArrival;
  final List<Override> extra;
  SimApp({this.hour = 15, this.pastArrival = true, this.extra = const []});

  /// Every route the app sent to the Hub, in order (device commands and scene activations).
  final List<String> sent = [];

  List<Override> get overrides => [
        simulatedResidenceProvider.overrideWithValue(sim),
        if (pastArrival) demoEnteredProvider.overrideWith((ref) => true),
        commandScheduleProvider.overrideWithValue(clock.schedule),
        hubSendProvider.overrideWithValue((path, body) {
          sent.add(path);
          return sim.transport.sendCommand(path, body);
        }),
        residenceHourProvider.overrideWithValue(hour),
        // No OS in a widget test: these two would open platform channels that do not exist here.
        pushTokenSourceProvider.overrideWithValue(null),
        mobileRuntimePlatformProvider
            .overrideWithValue(NoOpMobileRuntimePlatform()),
        networkChangeListenerProvider.overrideWith((ref) {}),
        ...extra,
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
    await tester.pumpWidget(
        ProviderScope(overrides: overrides, child: const SupremeMobileApp()));
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
