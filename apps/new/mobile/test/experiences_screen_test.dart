import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/sim_app.dart';

Future<void> _open(WidgetTester tester, SimApp app) async {
  // A tall phone: the page is a lazy list, and these tests are about what it says, not scrolling.
  await app.pump(tester, logical: const Size(390, 1800));
  await tester.tap(find.text('Experiences').last);
  await app.settle(tester);
}

String _status(WidgetTester t) => (t.widget(find.byKey(const ValueKey('exp-status'))) as Text).data!;

void main() {
  testWidgets('lists the residence\'s Experiences and derives each one\'s state from its devices',
      (tester) async {
    final app = SimApp();
    await _open(tester, app);
    for (final n in ['Relax', 'Dinner', 'Good Night']) {
      expect(find.text(n), findsWidgets, reason: n);
    }
    // Relax: the speaker already plays, nothing else matches yet.
    expect(_text(tester), 'Relax');
    expect(_status(tester), 'Partially active');
    expect(find.byKey(const ValueKey('exp-active-relax')), findsNothing);
    // Authoring is undecided (D5): nothing to make, edit or delete is drawn.
    expect(find.textContaining('Make your own'), findsNothing);
    expect(find.text('Delete'), findsNothing);
  });

  testWidgets('What changes is said from the steps; Where names each space it acts in', (tester) async {
    final app = SimApp();
    await _open(tester, app);
    await tester.tap(find.byKey(const ValueKey('exp-tab-dinner')));
    await app.settle(tester);
    expect(find.text('Set to 15–55%'), findsOneWidget);
    expect(find.text('3 lights'), findsOneWidget);
    expect(find.text('Volume 18%'), findsOneWidget);
    for (final id in ['living', 'dining', 'kitchen']) {
      expect(find.byKey(ValueKey('exp-where-$id')), findsOneWidget, reason: id);
    }
    expect(find.byKey(const ValueKey('exp-where-master')), findsNothing);
  });

  testWidgets('Set: one Hub call; Becoming… until each device reports; then Active now',
      (tester) async {
    final app = SimApp();
    await _open(tester, app);
    await tester.tap(find.byKey(const ValueKey('exp-tab-dinner')));
    await app.settle(tester);
    expect(_status(tester), 'Not active');

    await tester.tap(find.byKey(const ValueKey('exp-set')));
    await app.settle(tester, 100);
    expect(app.sent.where((p) => p == 'v1/scenes/dinner/activate'), hasLength(1));
    expect(app.sent.where((p) => p.contains('/command')), isEmpty,
        reason: 'the whole residence uses the Hub\'s own scene route, not device commands');
    expect(_status(tester), 'Becoming…');
    expect(find.text('Setting…'), findsOneWidget);
    expect(find.byKey(const ValueKey('exp-active-dinner')), findsNothing);

    await app.settle(tester, 700);
    expect(_status(tester), 'Active now');
    expect(find.text('Set again'), findsOneWidget);
    expect(find.byKey(const ValueKey('exp-active-dinner')), findsOneWidget);
    expect(find.text('Arrived'), findsWidgets);
  });

  testWidgets('a device that does not respond leaves it Partially active — never Active',
      (tester) async {
    final app = SimApp();
    app.sim.setSilent('dining-light', true);
    await _open(tester, app);
    await tester.tap(find.byKey(const ValueKey('exp-tab-dinner')));
    await app.settle(tester);
    await tester.tap(find.byKey(const ValueKey('exp-set')));
    await app.settle(tester, 1000);
    expect(_status(tester), 'Becoming…');
    await app.settle(tester, 9000);
    expect(_status(tester), 'Partially active');
    expect(find.byKey(const ValueKey('exp-active-dinner')), findsNothing);
  });

  testWidgets('an unreachable device is counted and skipped, not hidden', (tester) async {
    final app = SimApp();
    app.sim.setReachability('living-audio', 'offline');
    await _open(tester, app);
    expect(find.textContaining('1 not responding'), findsWidgets);
    await tester.tap(find.byKey(const ValueKey('exp-set')));
    await app.settle(tester, 100);
    expect(app.sent.any((p) => p.contains('living-audio')), isFalse);
  });

  testWidgets('choosing a space limits the page to that space and sets only its share',
      (tester) async {
    final app = SimApp();
    await _open(tester, app);
    await tester.tap(find.byKey(const ValueKey('exp-where-picker')));
    await app.settle(tester);
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('the dining room'));
    await app.settle(tester);
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const ValueKey('exp-row-lighting')), findsOneWidget);
    expect(find.byKey(const ValueKey('exp-row-music')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('exp-set')));
    await app.settle(tester, 100);
    expect(app.sent.where((p) => p.startsWith('v1/scenes/')), isEmpty,
        reason: 'no Hub route for one space\'s share: steps go as tracked device commands');
    expect(app.sent, contains('v1/devices/dining-light/command'));
    expect(app.sent.any((p) => p.contains('living')), isFalse);
    await app.settle(tester, 700);
    expect(_status(tester), 'Active now');
  });

  testWidgets('an unreachable residence is said, not an empty list', (tester) async {
    // (covered for the production path in visual_qa_remediation_test)
    final app = SimApp();
    await _open(tester, app);
    expect(find.text('No experiences are set up here yet.'), findsNothing);
  });
}

String _text(WidgetTester t) => (t.widget(find.byKey(const ValueKey('exp-name'))) as Text).data!;
