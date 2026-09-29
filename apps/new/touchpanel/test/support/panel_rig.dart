import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';
import 'package:supreme_touchpanel/residence/panel_residence.dart';

/// The panel's residence over the simulated Hub, on a manual clock — the transport boundary is
/// the only fake; `ResidenceState`, `CommandTracker` and `ExperienceActivations` are production.
class PanelRig {
  final clock = ManualScheduler();
  late final SimulatedResidence sim =
      SimulatedResidence(schedule: clock.schedule, now: clock.now);
  late final PanelResidence residence =
      PanelResidence.simulated(sim, schedule: clock.schedule, now: clock.now);

  /// Lets async reads land and advances simulated time; never waits on wall-clock timers.
  Future<void> settle(WidgetTester tester, [int ms = 0]) async {
    await tester.runAsync(() => clock.advance(Duration(milliseconds: ms)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }

  Future<void> dispose(WidgetTester tester) async {
    await tester.runAsync(() async {
      await residence.dispose();
      await sim.dispose();
    });
  }

  /// Mounts [child] under a panel-sized viewport with this residence in scope.
  Future<void> mount(WidgetTester tester, Widget child,
      {Size size = const Size(800, 1280), bool inScope = true}) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    addTearDown(() => dispose(tester));
    await tester.pumpWidget(MaterialApp(
      theme: buildSupremeTheme(),
      home: Scaffold(
        body: PanelResidenceScope(
          residence: inScope ? residence : null,
          child: AdaptiveScope(child: child),
        ),
      ),
    ));
    await settle(tester);
  }
}
