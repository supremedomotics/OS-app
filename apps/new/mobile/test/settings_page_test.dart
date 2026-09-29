import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/sim_app.dart';

Future<void> _open(WidgetTester tester, SimApp app) async {
  await app.pump(tester, logical: const Size(390, 1800));
  await tester.tap(find.text('Settings').last);
  await app.settle(tester);
}

void main() {
  testWidgets('Settings says what is true of this residence, and only that', (tester) async {
    final app = SimApp();
    await _open(tester, app);
    expect(find.text('Settings'), findsWidgets);
    expect(find.text('Everything is in order.'), findsOneWidget);
    expect(find.text('5 spaces on 2 levels'), findsOneWidget);
    expect(find.text('Connected'), findsOneWidget);
    // Nothing the residence cannot back is drawn.
    for (final t in ['Automations', 'Your experiences', 'Room photographs', 'Notifications',
      'Transparency', 'Make your own', 'Doors and movement', 'Someone is home']) {
      expect(find.text(t), findsNothing, reason: t);
    }
  });

  testWidgets('a device that is out is said in the lede and in the link status', (tester) async {
    final app = SimApp();
    app.sim.setReachability('dining-shade', 'offline');
    await _open(tester, app);
    expect(find.text('The dining room shades aren’t responding.'), findsOneWidget);
    expect(find.text('Connected · 1 not responding'), findsOneWidget);
  });

  testWidgets('Motion is a real device preference: choosing Reduced turns animation off for the app',
      (tester) async {
    final app = SimApp();
    await _open(tester, app);
    bool reduced() => MediaQuery.of(tester.element(find.byKey(const ValueKey('settings-page')))).disableAnimations;
    expect(reduced(), isFalse);
    await tester.tap(find.byKey(const ValueKey('choice-Motion-Reduced')));
    await app.settle(tester);
    expect(reduced(), isTrue);
    await tester.tap(find.byKey(const ValueKey('choice-Motion-As device')));
    await app.settle(tester);
    expect(reduced(), isFalse);
  });

  testWidgets('the Hubs page opens in place and returns', (tester) async {
    final app = SimApp();
    await _open(tester, app);
    await tester.tap(find.text('The residence and its Hubs'));
    await app.settle(tester);
    expect(find.byKey(const ValueKey('hubs-page')), findsOneWidget);
    expect(find.text('No Home paired yet'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('settings-back')));
    await app.settle(tester);
    expect(find.byKey(const ValueKey('settings-page')), findsOneWidget);
  });
}
