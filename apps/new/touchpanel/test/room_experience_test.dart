import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';
import 'package:supreme_touchpanel/experience/room_experience_screen.dart';

import 'support/panel_rig.dart';

Widget _room({bool connected = true, String id = 'living', String name = 'Living Room'}) =>
    RoomExperienceScreen(roomName: name, spaceId: id, connected: connected);

/// The Phase 7/8 completion criteria (§17, §Phase8-2..7): the SAME semantic
/// room experience composes itself differently across Touch Panel sizes,
/// through the real app widget tree — not a shrunk/enlarged copy of one
/// layout, and each tier shows the specific content Phase 8 calls for.
void main() {
  testWidgets(
      'micro (3-4in): room identity + one dominant Experience action, no domain grid',
      (tester) async {
    final rig = PanelRig();
    await rig.mount(tester, _room(), size: const Size(240, 320));

    expect(find.text('Living Room'), findsOneWidget);
    expect(find.byType(ExperienceControl),
        findsOneWidget); // the one dominant action
    expect(find.byType(LightingControl), findsNothing);
    expect(find.byType(ShadesControl), findsNothing);
    expect(find.byType(ClimateControl), findsNothing);
    expect(find.byType(AudioControl), findsNothing);
  });

  testWidgets('compact (5-7in): Lighting/Shades/Climate/Experience, no Audio',
      (tester) async {
    final rig = PanelRig();
    await rig.mount(tester, _room(), size: const Size(360, 640));

    expect(find.byType(LightingControl), findsOneWidget);
    expect(find.byType(ShadesControl), findsOneWidget);
    expect(find.byType(ClimateControl), findsOneWidget);
    expect(find.byType(ExperienceControl), findsOneWidget);
    expect(find.byType(AudioControl), findsNothing);
  });

  testWidgets(
      'standard (8-12in): balanced composition including Audio and multiple Experiences',
      (tester) async {
    final rig = PanelRig();
    await rig.mount(tester, _room(), size: const Size(800, 1280));

    expect(find.byType(LightingControl), findsOneWidget);
    expect(find.byType(ShadesControl), findsOneWidget);
    expect(find.byType(ClimateControl), findsOneWidget);
    expect(find.byType(AudioControl), findsOneWidget);
    // The Experience tiles are further down this ListView (stackedControls,
    // §Phase7-6) than the viewport — scroll to them rather than asserting
    // on off-screen (unbuilt) list items.
    await tester.drag(find.byType(ListView), const Offset(0, -600));
    await tester.pumpAndSettle();
    expect(find.byType(ExperienceControl), findsWidgets);
  });

  testWidgets(
      'expanded (13-20in): atmosphere panel + primary controls + Experiences',
      (tester) async {
    final rig = PanelRig();
    await rig.mount(tester, _room(), size: const Size(1600, 1000));

    expect(find.text('Atmosphere'), findsOneWidget);
    expect(find.byType(LightingControl), findsOneWidget);
    expect(find.byType(ClimateControl), findsOneWidget);
    expect(find.byType(ExperienceControl), findsWidgets);
  });

  testWidgets(
      'immersive (21-30in+): atmosphere + Lighting/Climate + Shades/Audio + Experiences panels '
      '(§Phase7-8 — not an enlarged small-screen layout)', (tester) async {
    final rig = PanelRig();
    await rig.mount(tester, _room(), size: const Size(2400, 1500));

    expect(find.text('Atmosphere'), findsOneWidget);
    expect(find.text('Experiences'), findsOneWidget);
    expect(find.byType(LightingControl), findsOneWidget);
    expect(find.byType(ClimateControl), findsOneWidget);
    expect(find.byType(ShadesControl), findsOneWidget);
    expect(find.byType(AudioControl), findsOneWidget);
    expect(find.byType(ExperienceControl), findsWidgets);
    // Not a single-action screen, and not a plain scrolling list either.
    expect(find.byType(ListView), findsNothing);
  });

  testWidgets(
      'the same room renders materially different widget trees across sizes',
      (tester) async {
    final rig = PanelRig();
    await rig.mount(tester, _room(), size: const Size(240, 320));
    final microCardCount = find.byType(SupremeCard).evaluate().length;

    tester.view.physicalSize = const Size(2400, 1500);
    await rig.settle(tester);
    final immersiveCardCount = find.byType(SupremeCard).evaluate().length;

    expect(immersiveCardCount, greaterThan(microCardCount));
  });

  group('state feedback (§Phase8-14)', () {
    testWidgets(
        'activating an Experience shows Applying…, and is active only when the devices report it',
        (tester) async {
      final rig = PanelRig();
      await rig.mount(tester, _room(), size: const Size(240, 320));

      expect(find.text('Relax'), findsOneWidget);
      expect(find.text('Applying…'), findsNothing);

      await tester.tap(find.byType(ExperienceControl));
      await rig.settle(tester, 10);

      expect(find.text('Applying…'), findsOneWidget);
      expect(find.text('Relax'), findsNothing);
      expect(rig.sim.deviceJson('living-shade')['state']['position']['position'], 100,
          reason: 'a tap (and a request) move nothing; the Hub sequences the curtains first');

      // The Hub runs it (curtains first, then light and music); devices report as they finish.
      await rig.settle(tester, 1000);
      expect(find.text('Applying…'), findsOneWidget, reason: 'still moving: not confirmed yet');
      await rig.settle(tester, 30000);
      expect(find.text('Relax · Active'), findsOneWidget);
      expect(find.text('Applying…'), findsNothing);
    });

    testWidgets('the light switch is confirmed by the device, not by the tap', (tester) async {
      final rig = PanelRig();
      await rig.mount(tester, _room(), size: const Size(800, 1280));
      expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue, reason: 'lights reported on');

      await tester.tap(find.byType(Switch));
      await rig.settle(tester, 10);
      expect(find.text('Applying…'), findsWidgets);
      expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue,
          reason: 'still what the device reports');

      await rig.settle(tester, 1000);
      expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
      expect(find.text('Applying…'), findsNothing);
    });
  });

  group('honest without a residence', () {
    testWidgets('no residence: the room says so and draws no control', (tester) async {
      final rig = PanelRig();
      await rig.mount(tester, _room(), inScope: false);
      expect(find.byKey(const ValueKey('panel-waiting')), findsOneWidget);
      expect(find.byType(LightingControl), findsNothing);
      expect(find.byType(ExperienceControl), findsNothing);
      expect(find.text('Living Room'), findsOneWidget);
    });

    testWidgets('a room the Hub does not have is said, not drawn', (tester) async {
      final rig = PanelRig();
      await rig.mount(tester, _room(id: 'cellar', name: 'Cellar'));
      expect(find.text('This room is not part of the residence.'), findsOneWidget);
    });

    testWidgets('a device the room does not have gets no control (dining has no climate)',
        (tester) async {
      final rig = PanelRig();
      await rig.mount(tester, _room(id: 'dining', name: 'Dining Room'));
      expect(find.byType(LightingControl), findsOneWidget);
      expect(find.byType(ClimateControl), findsNothing);
      expect(find.byType(AudioControl), findsNothing);
    });
  });

  group('connection loss disables commands (§Phase8-15)', () {
    testWidgets('disconnected: Lighting/Shades/Climate become non-interactive',
        (tester) async {
      final rig = PanelRig();
      await rig.mount(tester, _room(connected: false));

      final lightSwitch = tester.widget<Switch>(find.byType(Switch));
      expect(lightSwitch.onChanged, isNull);

      final incrementButtons =
          tester.widgetList<IconButton>(find.byType(IconButton));
      expect(incrementButtons.every((b) => b.onPressed == null), isTrue);
    });

    testWidgets('connected: the same controls are interactive', (tester) async {
      final rig = PanelRig();
      await rig.mount(tester, _room());

      final lightSwitch = tester.widget<Switch>(find.byType(Switch));
      expect(lightSwitch.onChanged, isNotNull);
    });
  });

  group('touch target requirements hold at every tier (§Phase7-4, §Phase8-16)',
      () {
    testWidgets('micro Experience action clears its tier minimum',
        (tester) async {
      final rig = PanelRig();
      await rig.mount(tester, _room(), size: const Size(240, 320));

      final size = tester.getSize(find.byType(ExperienceControl));
      expect(size.height, greaterThanOrEqualTo(72));
    });
  });

  group('no machine ids in homeowner UI (§Phase7.1)', () {
    testWidgets('room name renders as given (a display name, never a raw id)',
        (tester) async {
      final rig = PanelRig();
      await rig.mount(tester, _room());

      expect(find.text('Living Room'), findsWidgets);
      expect(find.text('living'), findsNothing);
    });
  });
}
