import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import 'support/sim_app.dart';

/// Devices — the inventory and the Device Sheet — against the simulated residence. Everything is
/// derived from device state; a sheet offers exactly the controls its device declares.
Future<void> _scrollTo(WidgetTester tester, Finder f, {String list = 'devices-list'}) async {
  await tester.scrollUntilVisible(f, 200,
      scrollable: find.descendant(
          of: find.byKey(ValueKey(list)), matching: find.byType(Scrollable)));
  await tester.pump();
}

Future<void> _openDevices(WidgetTester tester, SimApp app) async {
  await app.openControl(tester);
  await tester.tap(find.byKey(const ValueKey('control-devices')));
  await app.settle(tester);
  await tester.pump(const Duration(milliseconds: 600));
}

void main() {
  testWidgets('Control names the inventory and how many devices are in it', (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await app.openControl(tester);
    expect(find.byKey(const ValueKey('control-devices')), findsOneWidget);
    expect(find.text('All 12 devices'), findsOneWidget);
    expect(find.text('PHYSICAL OBJECTS'), findsOneWidget);
  });

  testWidgets('the inventory: in use now, then what the residence is made of', (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _openDevices(tester, app);

    expect(find.byKey(const ValueKey('devices-layer')), findsOneWidget);
    expect(find.text('Devices'), findsWidgets);
    expect(find.text('12 devices'), findsOneWidget);
    expect(find.text('IN USE NOW'), findsOneWidget);
    expect(find.text('NEEDS ATTENTION'), findsNothing, reason: 'everything is responding');
    // In use: said in words, with the place.
    expect(find.text('Living Room · On · 60%'), findsOneWidget);
    expect(find.text('WHAT THE RESIDENCE IS MADE OF'), findsOneWidget);

    await _scrollTo(tester, find.byKey(const ValueKey('devices-group-lighting')));
    expect(find.text('Lighting · 5'), findsOneWidget);
    await _scrollTo(tester, find.byKey(const ValueKey('devices-group-media')));
    expect(find.text('Media · 2'), findsOneWidget);
    // No "Other" group: every simulated device declares a function.
    expect(find.byKey(const ValueKey('devices-group-other')), findsNothing);
  });

  testWidgets('floor headings appear only when the inventory spans floors', (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _openDevices(tester, app);
    await _scrollTo(tester, find.byKey(const ValueKey('devices-group-lighting')));
    expect(find.text('GROUND FLOOR'), findsWidgets, reason: 'the residence has two floors');
    expect(find.text('FIRST FLOOR'), findsWidgets);
  });

  testWidgets('scoped to one room there is no floor or room heading to repeat', (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await tester.tap(find.text('Spaces').last);
    await app.settle(tester);
    final plate = find.byKey(const ValueKey('space-living'));
    await tester.scrollUntilVisible(plate, 300, scrollable: find.byType(Scrollable).first);
    await tester.ensureVisible(plate);
    await tester.pump();
    await tester.tap(plate);
    await app.settle(tester);
    await _openDevices(tester, app);
    expect(find.text('Living Room devices'), findsOneWidget);
    expect(
        find.descendant(
            of: find.byKey(const ValueKey('devices-layer')),
            matching: find.text('GROUND FLOOR')),
        findsNothing);
    expect(find.text('4 devices'), findsOneWidget);
  });

  testWidgets('a device opens its sheet: generated from its capabilities, and a working control',
      (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _openDevices(tester, app);
    final row = find.byKey(const ValueKey('device-living-light')).first;
    await tester.ensureVisible(row);
    await tester.tap(row);
    await app.settle(tester);
    await tester.pump(const Duration(milliseconds: 600));

    expect(find.byKey(const ValueKey('device-sheet')), findsOneWidget);
    expect(find.text('Living Room lights'), findsWidgets);
    expect(find.text('LIGHTING · LIVING ROOM'), findsOneWidget);
    // The same Lights block Control uses, for this one device.
    SupremeSwitch sw() => tester.widget<SupremeSwitch>(find.byKey(const ValueKey('lights-switch')));
    expect(sw().on, isTrue);
    // A light has no shades, climate or music: none is drawn.
    expect(find.text('Position'), findsNothing);
    expect(find.text('Music'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('lights-switch')));
    await app.settle(tester, 50);
    expect(sw().pending, isTrue);
    expect(sw().on, isTrue, reason: 'still what the device reports');
    await app.settle(tester, 700);
    expect(sw().on, isFalse);
    expect(app.sent, contains('v1/devices/living-light/command'));
  });

  testWidgets('a shade\'s sheet offers a position, not a light switch', (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _openDevices(tester, app);
    final row = find.byKey(const ValueKey('device-living-shade')).last;
    await _scrollTo(tester, find.byKey(const ValueKey('devices-group-shades')));
    await tester.ensureVisible(row);
    await tester.tap(row);
    await app.settle(tester);
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('SHADES · LIVING ROOM'), findsOneWidget);
    expect(find.byKey(const ValueKey('shades-position')), findsOneWidget);
    expect(find.byKey(const ValueKey('lights-switch')), findsNothing);
  });

  testWidgets('what is out: Home\'s note opens only what is not responding, and the sheet says so',
      (tester) async {
    final app = SimApp();
    app.sim.setReachability('dining-shade', 'offline');
    await app.pump(tester);
    expect(find.byKey(const ValueKey('home-note-open')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('home-note-open')));
    await app.settle(tester);
    await tester.pump(const Duration(milliseconds: 600));

    expect(find.text('Not responding'), findsWidgets);
    expect(find.byKey(const ValueKey('device-dining-shade')), findsOneWidget);
    expect(find.byKey(const ValueKey('device-living-light')), findsNothing,
        reason: 'only what is out');
    expect(find.text('Dining Room · Not responding'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('device-dining-shade')));
    await app.settle(tester);
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.byKey(const ValueKey('device-sheet')), findsOneWidget);
    expect(find.textContaining('isn’t responding'), findsWidgets);
    expect(find.textContaining('last reported'), findsOneWidget);
  });

  testWidgets('everything responding: the attention view says so instead of listing nothing',
      (tester) async {
    final app = SimApp();
    await app.pump(tester);
    expect(find.byKey(const ValueKey('home-note-open')), findsNothing, reason: 'nothing is out');
  });

  testWidgets('a space that has a device out links its own devices', (tester) async {
    final app = SimApp();
    app.sim.setReachability('living-audio', 'offline');
    await app.pump(tester);
    await tester.tap(find.text('Spaces').last);
    await app.settle(tester);
    final plate = find.byKey(const ValueKey('space-living'));
    await tester.scrollUntilVisible(plate, 300, scrollable: find.byType(Scrollable).first);
    await tester.ensureVisible(plate);
    await tester.pump();
    await tester.tap(plate);
    await app.settle(tester);

    await tester.tap(find.byKey(const ValueKey('space-attention-open')));
    await app.settle(tester);
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('Living Room devices'.toUpperCase()), findsNothing);
    expect(find.byKey(const ValueKey('device-living-audio')), findsOneWidget);
    expect(find.byKey(const ValueKey('device-dining-shade')), findsNothing);
  });
}
