import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/sim_app.dart';

/// A space's photograph is a Hub-served, authenticated, versioned resource (ADR 0102): shown when
/// the Hub supplies it, and the honest tonal plate otherwise.
final _png = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==');

Finder _pictureIn(Finder scope) =>
    find.descendant(of: scope, matching: find.byType(Image));

Future<void> _spaces(WidgetTester tester, SimApp app) async {
  await tester.tap(find.text('Spaces').last);
  await app.settle(tester);
  await app.settle(tester, 100);
}

void main() {
  testWidgets('a room with a photograph shows the Hub\'s picture on its plate', (tester) async {
    final app = SimApp();
    app.sim.setHeroImage('living', _png);
    await app.pump(tester);
    await _spaces(tester, app);
    final plate = find.byKey(const ValueKey('space-living'));
    expect(_pictureIn(plate), findsOneWidget);
    expect(tester.widget<Image>(_pictureIn(plate)).image, isA<MemoryImage>());
    expect(_pictureIn(find.byKey(const ValueKey('space-dining'))), findsNothing,
        reason: 'no photograph, no picture: a tonal plate, never a stand-in');
  });

  testWidgets('no photograph anywhere: every plate is tonal', (tester) async {
    final app = SimApp();
    await app.pump(tester);
    await _spaces(tester, app);
    expect(find.byType(Image), findsNothing);
  });

  testWidgets('the picture is fetched with the Hub\'s versioned URL, once', (tester) async {
    final app = SimApp();
    app.sim.setHeroImage('living', _png);
    await app.pump(tester);
    await _spaces(tester, app);
    await tester.tap(find.text('Home').last);
    await app.settle(tester);
    await _spaces(tester, app);
    expect(_pictureIn(find.byKey(const ValueKey('space-living'))), findsOneWidget);
    expect(app.sim.byteReads, ['/v1/rooms/living/hero-image?v=${app.sim.heroVersion('living')}'],
        reason: 'cached by its content-hashed URL; navigating away and back does not refetch');
  });
}
