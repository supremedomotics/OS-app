import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';
import 'package:supreme_touchpanel/experience/room_experience_screen.dart';

Widget _panelAt(Size size, {bool connected = true}) {
  return MediaQuery(
    data: MediaQueryData(size: size),
    child: MaterialApp(
      theme: buildSupremeTheme(),
      // Scaffold, not bare Material — matches the real app: AssignedScreen
      // wraps RoomExperienceScreen in a Scaffold too.
      home: Scaffold(
        body: AdaptiveScope(
          child: RoomExperienceScreen(
              roomName: 'Living Room', connected: connected),
        ),
      ),
    ),
  );
}

/// The Phase 7/8 completion criteria (§17, §Phase8-2..7): the SAME semantic
/// room experience composes itself differently across Touch Panel sizes,
/// through the real app widget tree — not a shrunk/enlarged copy of one
/// layout, and each tier shows the specific content Phase 8 calls for.
void main() {
  testWidgets(
      'micro (3-4in): room identity + one dominant Experience action, no domain grid',
      (tester) async {
    await tester.pumpWidget(_panelAt(const Size(240, 320)));
    await tester.pumpAndSettle();

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
    await tester.pumpWidget(_panelAt(const Size(360, 640)));
    await tester.pumpAndSettle();

    expect(find.byType(LightingControl), findsOneWidget);
    expect(find.byType(ShadesControl), findsOneWidget);
    expect(find.byType(ClimateControl), findsOneWidget);
    expect(find.byType(ExperienceControl), findsOneWidget);
    expect(find.byType(AudioControl), findsNothing);
  });

  testWidgets(
      'standard (8-12in): balanced composition including Audio and multiple Experiences',
      (tester) async {
    await tester.pumpWidget(_panelAt(const Size(800, 1280)));
    await tester.pumpAndSettle();

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
    await tester.pumpWidget(_panelAt(const Size(1600, 1000)));
    await tester.pumpAndSettle();

    expect(find.text('Atmosphere'), findsOneWidget);
    expect(find.byType(LightingControl), findsOneWidget);
    expect(find.byType(ClimateControl), findsOneWidget);
    expect(find.byType(ExperienceControl), findsWidgets);
  });

  testWidgets(
      'immersive (21-30in+): atmosphere + Lighting/Climate + Shades/Audio + Experiences panels '
      '(§Phase7-8 — not an enlarged small-screen layout)', (tester) async {
    await tester.pumpWidget(_panelAt(const Size(2400, 1500)));
    await tester.pumpAndSettle();

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
    await tester.pumpWidget(_panelAt(const Size(240, 320)));
    await tester.pumpAndSettle();
    final microCardCount = find.byType(SupremeCard).evaluate().length;

    await tester.pumpWidget(_panelAt(const Size(2400, 1500)));
    await tester.pumpAndSettle();
    final immersiveCardCount = find.byType(SupremeCard).evaluate().length;

    expect(immersiveCardCount, greaterThan(microCardCount));
  });

  group('state feedback (§Phase8-14)', () {
    testWidgets(
        'activating an Experience shows Applying… then the Experience name',
        (tester) async {
      await tester.pumpWidget(_panelAt(const Size(240, 320)));
      await tester.pumpAndSettle();

      expect(find.text('Relax'), findsOneWidget);
      expect(find.text('Applying…'), findsNothing);

      await tester.tap(find.byType(ExperienceControl));
      await tester.pump(); // one frame: requested state shows immediately

      expect(find.text('Applying…'), findsOneWidget);
      expect(find.text('Relax'), findsNothing);

      await tester.pumpAndSettle(); // Hub "confirms" after the mock delay

      expect(find.text('Relax'), findsOneWidget);
      expect(find.text('Applying…'), findsNothing);
    });
  });

  group('connection loss disables commands (§Phase8-15)', () {
    testWidgets('disconnected: Lighting/Shades/Climate become non-interactive',
        (tester) async {
      await tester
          .pumpWidget(_panelAt(const Size(800, 1280), connected: false));
      await tester.pumpAndSettle();

      final lightSwitch = tester.widget<Switch>(find.byType(Switch));
      expect(lightSwitch.onChanged, isNull);

      final incrementButtons =
          tester.widgetList<IconButton>(find.byType(IconButton));
      expect(incrementButtons.every((b) => b.onPressed == null), isTrue);
    });

    testWidgets('connected: the same controls are interactive', (tester) async {
      await tester.pumpWidget(_panelAt(const Size(800, 1280)));
      await tester.pumpAndSettle();

      final lightSwitch = tester.widget<Switch>(find.byType(Switch));
      expect(lightSwitch.onChanged, isNotNull);
    });
  });

  group('touch target requirements hold at every tier (§Phase7-4, §Phase8-16)',
      () {
    testWidgets('micro Experience action clears its tier minimum',
        (tester) async {
      await tester.pumpWidget(_panelAt(const Size(240, 320)));
      await tester.pumpAndSettle();

      final size = tester.getSize(find.byType(ExperienceControl));
      expect(size.height, greaterThanOrEqualTo(72));
    });
  });

  group('no machine ids in homeowner UI (§Phase7.1)', () {
    testWidgets('room name renders as given (a display name, never a raw id)',
        (tester) async {
      await tester.pumpWidget(_panelAt(const Size(800, 1280)));
      await tester.pumpAndSettle();

      expect(find.text('Living Room'), findsWidgets);
      expect(find.text('living-room'), findsNothing);
    });
  });
}
