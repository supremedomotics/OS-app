import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/sim_app.dart';
import 'package:supreme_mobile_next/main.dart';

void main() {
  testWidgets('Spaces shows the residence by floor, in words derived from device state',
      (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await tester.tap(find.text('Spaces').last);
    await app.settle(tester);

    expect(find.text('VILLA SON VIDA'), findsWidgets);
    expect(find.text('Ground floor'), findsOneWidget);
    // The page is a lazy list: walk it, as a person would, and see every space on its floor.
    final seen = <String>{};
    for (var i = 0; i < 12; i++) {
      for (final n in ['Living Room', 'Dining Room', 'Kitchen', 'Terrace', 'Master Bedroom', 'First floor']) {
        if (find.text(n).evaluate().isNotEmpty) seen.add(n);
      }
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -300));
      await tester.pump();
    }
    expect(seen, {'Living Room', 'Dining Room', 'Kitchen', 'Terrace', 'Master Bedroom', 'First floor'});
    // Living room: 60 % dimmer, speaker playing. No claim about warmth (no kelvin), no device count.
    expect(find.text('Lights on · Music'), findsOneWidget);
    expect(find.text('Daylight only'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a plate follows the residence: a physical change reaches the words with no command',
      (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await tester.tap(find.text('Spaces').last);
    await app.settle(tester);
    expect(find.text('Lights on · Music'), findsOneWidget);

    app.sim.changePhysically('living-audio',
        {'capability': 'media', 'action': 'pause'});
    await app.settle(tester, 100);
    expect(find.text('Lights on · Music'), findsNothing);
    expect(find.text('Lights on'), findsNWidgets(2), reason: 'living and dining');
  });

  testWidgets('a device that stops responding is flagged on its plate, never hidden',
      (tester) async {
    final app = SimApp();
    app.sim.setReachability('dining-light', 'offline');
    await app.pump(tester);
    await tester.tap(find.text('Spaces').last);
    await app.settle(tester);
    expect(find.text('1 not responding'), findsOneWidget);
  });

  testWidgets('opening a plate opens the space', (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await tester.tap(find.text('Spaces').last);
    await app.settle(tester);
    await tester.scrollUntilVisible(find.byKey(const ValueKey('space-kitchen')), 300,
        scrollable: find.byType(Scrollable).first);
    await tester.ensureVisible(find.byKey(const ValueKey('space-kitchen')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('space-kitchen')));
    await app.settle(tester);
    expect(find.byKey(const ValueKey('space-page-kitchen')), findsOneWidget);
  });
}
