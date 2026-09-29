import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_mobile_next/features/spaces/space_screen.dart';
import 'package:supreme_mobile_next/main.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import 'support/sim_app.dart';

/// The Space page against the simulated residence: words follow confirmed state; a control's
/// requested value is never shown as the fact; failures are said and the reported value returns.
Future<void> _openSpace(WidgetTester tester, SimApp app, String id) async {
  await tester.tap(find.text('Spaces').last);
  await app.settle(tester);
  final plate = find.byKey(ValueKey('space-$id'));
  await tester.scrollUntilVisible(plate, 300,
      scrollable: find.byType(Scrollable).first);
  await tester.ensureVisible(plate);
  await tester.pump();
  await tester.tap(plate);
  await app.settle(tester);
}

void main() {
  testWidgets('says how the space feels and what it is like, from devices', (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _openSpace(tester, app, 'living');
    expect(find.text('Living Room'), findsOneWidget);
    expect(find.text('Its own atmosphere.'), findsOneWidget);
    expect(find.text('Lights on · 22.5° · Curtains open · Music playing'), findsOneWidget);
    expect(find.text('GROUND FLOOR'), findsOneWidget);
    // Shape is undecided (D5): its entry is not drawn.
    expect(find.text('Shape'), findsNothing);
  });

  testWidgets('a room with nothing on says so', (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _openSpace(tester, app, 'kitchen');
    expect(find.text('Nothing is on'), findsOneWidget);
    // Derived, not chosen: the kitchen's light is already off, which is all Good Night asks of it.
    expect(find.text('Feels like Good Night.'), findsOneWidget);
  });

  testWidgets('a phone keeps the page quiet: controls are reached through Control, in this space\'s scope',
      (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _openSpace(tester, app, 'kitchen');
    expect(find.byKey(const ValueKey('imm-lights')), findsNothing);

    await app.openControl(tester);
    expect(find.byKey(const ValueKey('control-layer')), findsOneWidget);
    expect(find.text('Kitchen'), findsWidgets);
    expect(find.byKey(const ValueKey('control-system-lighting')), findsOneWidget);
    // The kitchen has only lights: no Climate, Shades or Media rows to look at.
    expect(find.byKey(const ValueKey('control-system-climate')), findsNothing);
    expect(find.byKey(const ValueKey('control-system-shades')), findsNothing);
    expect(find.byKey(const ValueKey('control-system-media')), findsNothing);
  });

  testWidgets('lights via Control: requested → pending → confirmed only by the device report',
      (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _openSpace(tester, app, 'kitchen');
    await app.openControl(tester);
    await tester.tap(find.byKey(const ValueKey('control-system-lighting')));
    await app.settle(tester);

    SupremeSwitch sw() =>
        tester.widget<SupremeSwitch>(find.byKey(const ValueKey('lights-switch')));
    expect(sw().on, isFalse);
    expect(sw().pending, isFalse);

    await tester.tap(find.byKey(const ValueKey('lights-switch')));
    await app.settle(tester, 100);
    expect(sw().on, isFalse, reason: 'accepted, not yet reported: still what the device reports');
    expect(sw().pending, isTrue);

    await app.settle(tester, 600);
    expect(sw().on, isTrue);
    expect(sw().pending, isFalse);
  });

  testWidgets('a device that never reports: the request fails, it is said, and the reported value returns',
      (tester) async {
    final app = SimApp();
    app.sim.setSilent('kitchen-light', true);
    await app.pump(tester);
    await _openSpace(tester, app, 'kitchen');
    await app.openControl(tester);
    await tester.tap(find.byKey(const ValueKey('control-system-lighting')));
    await app.settle(tester);
    await tester.tap(find.byKey(const ValueKey('lights-switch')));
    await app.settle(tester, 1000);
    expect(tester.widget<SupremeSwitch>(find.byKey(const ValueKey('lights-switch'))).pending, isTrue);

    await app.settle(tester, 9000);
    final sw = tester.widget<SupremeSwitch>(find.byKey(const ValueKey('lights-switch')));
    expect(sw.pending, isFalse);
    expect(sw.on, isFalse);
    expect(find.text('The lights didn’t respond.'), findsOneWidget);
  });

  testWidgets('climate via Control: the stepper builds on the request; confirmed by the thermostat',
      (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _openSpace(tester, app, 'living');
    await app.openControl(tester);
    await tester.tap(find.byKey(const ValueKey('control-system-climate')));
    await app.settle(tester);
    expect(find.text('22.0°'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Higher — Living Room climate'));
    await app.settle(tester, 100);
    expect(find.text('23.0°'), findsOneWidget, reason: 'the request, shown as pending');
    expect(find.textContaining('setting 23.0°'), findsOneWidget);
    await app.settle(tester, 600);
    expect(find.textContaining('setting'), findsNothing);
    expect(find.text('23.0°'), findsOneWidget);
    expect((app.sim.deviceJson('living-climate')['state']['temperature'] as Map)['targetC'], 23.0);
  });

  testWidgets('a physical change while the page is open reaches the words', (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _openSpace(tester, app, 'kitchen');
    app.sim.changePhysically('kitchen-light',
        {'capability': 'brightness', 'action': 'set', 'level': 90});
    await app.settle(tester, 100);
    expect(find.text('Its own atmosphere.'), findsOneWidget);
    expect(find.textContaining('Bright light'), findsOneWidget);
  });

  testWidgets('a room device that is out is named on the page, not hidden', (tester) async {
    final app = SimApp();
    app.sim.setReachability('living-audio', 'offline');
    await app.pump(tester);
    await _openSpace(tester, app, 'living');
    expect(find.byKey(const ValueKey('space-attention')), findsOneWidget);
    expect(find.textContaining('Living Room speaker isn’t responding.'), findsOneWidget);
  });

  testWidgets('Change lists the Experiences that act here; choosing one runs its steps in this space only',
      (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _openSpace(tester, app, 'dining');
    await tester.tap(find.byKey(const ValueKey('space-change')));
    await app.settle(tester);
    expect(find.text('Relax'), findsOneWidget);
    expect(find.text('Dinner'), findsOneWidget);
    expect(find.text('Good Night'), findsOneWidget);

    await tester.tap(find.text('Dinner'));
    await app.settle(tester, 100);
    expect(find.text('Becoming Dinner…'), findsOneWidget);
    await app.settle(tester, 700);
    expect(find.text('Feels like Dinner.'), findsOneWidget);
    // Only this room's steps ran: the living room's light is unchanged.
    expect((app.sim.deviceJson('living-light')['state']['brightness'] as Map)['level'], 60);
  });

  testWidgets('back returns to the list of spaces', (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _openSpace(tester, app, 'kitchen');
    await tester.tap(find.byKey(const ValueKey('space-back')));
    await app.settle(tester);
    expect(find.byKey(const ValueKey('spaces-page')), findsOneWidget);
  });

  group('a compact room panel acts on the room where it is described', () {
    Future<SimApp> pumpPanel(WidgetTester tester, String spaceId) async {
      final app = SimApp();
      SharedPreferences.setMockInitialValues({});
      tester.view.physicalSize = const Size(320, 480) * 2;
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 30));
      });
      await tester.pumpWidget(ProviderScope(
        overrides: app.overrides,
        child: MaterialApp(
          theme: buildSupremeTheme(),
          builder: (c, child) => SurfaceScope(
              installedPanel: SurfacePanelBinding.room,
              physicalSizeInches: 4,
              child: AdaptiveScope(child: child!)),
          home: Scaffold(
              body: SpaceScreen(spaceId: spaceId, onBack: () {})),
        ),
      ));
      await app.settle(tester);
      return app;
    }

    testWidgets('one line per system, only what the room can do', (tester) async {
      await pumpPanel(tester, 'living');
      for (final k in ['lights', 'shades', 'climate-living-climate', 'music-living-audio']) {
        expect(find.byKey(ValueKey('imm-$k')), findsOneWidget, reason: k);
      }
      expect(find.byKey(const ValueKey('imm-music-terrace-audio')), findsNothing);
    });

    testWidgets('a kitchen panel offers lights and nothing else', (tester) async {
      await pumpPanel(tester, 'kitchen');
      expect(find.byKey(const ValueKey('imm-lights')), findsOneWidget);
      expect(find.byKey(const ValueKey('imm-shades')), findsNothing);
    });

    testWidgets('Draw the curtains: pending words, then the shade actually arrives', (tester) async {
      final app = await pumpPanel(tester, 'living');
      expect(find.text('Open'), findsOneWidget);
      await tester.tap(find.text('Draw'));
      await app.settle(tester, 100);
      expect(find.text('Closing…'), findsOneWidget);
      await app.settle(tester, 700);
      expect(find.text('Closing…'), findsOneWidget,
          reason: 'moving through intermediate positions is not yet arrived');
      await app.settle(tester, 6000);
      expect(find.text('Drawn'), findsOneWidget);
      expect(find.text('Closing…'), findsNothing);
    });
  });
}
