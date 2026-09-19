import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_mobile_next/main.dart';

/// §QA-05 regression — reproduces the ORIGINAL bug exactly as observed: navigate
/// More -> Settings (a real `Navigator.push`), which used to crash with
/// "Null check operator used on a null value" because the pushed route's `BuildContext` had no
/// `AdaptiveScope` ancestor (only `home` was wrapped). Fixed by wrapping the WHOLE app —
/// `MaterialApp.builder`, so every current and future pushed route inherits it.
///
/// This test intentionally exercises `tester.takeException()` directly rather than only
/// asserting text is visible — a widget that silently renders a grey error screen would still
/// pass a "text findsNothing"-style check without this.
void main() {
  // §QA-05 regression note: without a mocked shared_preferences backend, `PairedHomeController
  // .load()` hangs forever on the real plugin's method channel (no handler in a widget test),
  // so `HomeSettingsScreen` never leaves its `CircularProgressIndicator` state and
  // `pumpAndSettle()` times out waiting for that indeterminate animation to stop — a test-harness
  // gap, not the app bug this file targets.
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets(
      'navigating More -> Settings never throws and renders the real Settings screen (§QA-05)',
      (tester) async {
    await tester.pumpWidget(const ProviderScope(child: SupremeMobileApp()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('More'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();

    // The real crash this test reproduces would throw during this pump — takeException()
    // returns the FIRST uncaught exception recorded, or null if none occurred.
    expect(tester.takeException(), isNull);
    expect(find.widgetWithText(AppBar, 'Settings'), findsOneWidget);
  });

  testWidgets(
      'navigating More -> Settings -> Home never throws, even with no Home paired (§QA-05)',
      (tester) async {
    await tester.pumpWidget(const ProviderScope(child: SupremeMobileApp()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('More'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Home'));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    // HomeSettingsScreen's own real empty state — proves the screen actually rendered its
    // content, not just "didn't crash."
    expect(find.text('No Home paired yet'), findsOneWidget);
  });
}
