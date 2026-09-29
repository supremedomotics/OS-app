import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/sim_app.dart';

String _text(WidgetTester t, String key) =>
    (t.widget(find.byKey(ValueKey(key))) as Text).data!;

void main() {
  testWidgets('Home says what the residence is like, from confirmed state', (tester) async {
    final app = SimApp(hour: 19);
    await app.pump(tester);
    expect(find.byKey(const ValueKey('home-page')), findsOneWidget);
    expect(_text(tester, 'home-name'), 'Villa Son Vida');
    expect(_text(tester, 'home-state'), 'Everything is settled.');
    // light · temperature · sound — each from a device report
    expect(find.text('Evening light'), findsOneWidget);
    expect(find.text('21.8°'), findsOneWidget);
    expect(find.text('Music in the living room'), findsOneWidget);
    // No protection claim: nothing in the residence can prove one.
    expect(find.text('Secure'), findsNothing);
    expect(find.text('Protected'), findsNothing);
  });

  testWidgets('it follows the residence live: a light on, a speaker paused', (tester) async {
    final app = SimApp(hour: 23);
    await app.pump(tester);
    expect(find.text('Music in the living room'), findsOneWidget);
    app.sim.changePhysically('living-audio', {'capability': 'media', 'action': 'pause'});
    await app.settle(tester, 100);
    expect(find.text('Music in the living room'), findsNothing);
    expect(find.text('Quiet'), findsOneWidget);
  });

  testWidgets('never says everything is settled while something is out', (tester) async {
    final app = SimApp();
    app.sim.setReachability('dining-shade', 'offline');
    await app.pump(tester);
    expect(_text(tester, 'home-state'), 'Settled, except the dining room shades.');
    expect(_text(tester, 'home-note'), 'The dining room shades aren’t responding.');
  });

  testWidgets('an Experience set from Experiences shows on Home only when the devices arrive',
      (tester) async {
    final app = SimApp(hour: 23);
    await app.pump(tester, logical: const Size(390, 1800));
    expect(find.byKey(const ValueKey('home-feels')), findsNothing);

    await tester.tap(find.text('Experiences').last);
    await app.settle(tester);
    await tester.scrollUntilVisible(find.byKey(const ValueKey('exp-set')), 200,
        scrollable: find.byType(Scrollable).first);
    await tester.tap(find.byKey(const ValueKey('exp-tab-good-night')));
    await app.settle(tester);
    await tester.tap(find.byKey(const ValueKey('exp-set')));
    await app.settle(tester, 100);

    await tester.tap(find.text('Home').last);
    await app.settle(tester);
    expect(_text(tester, 'home-state'), 'Setting Good Night…');

    await app.settle(tester, 7000);
    expect(_text(tester, 'home-state'), 'The residence is resting.');
    expect(_text(tester, 'home-feels'), 'Feels like Good Night');
  });
}
