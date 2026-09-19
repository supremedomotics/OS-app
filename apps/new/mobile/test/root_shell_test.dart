import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_mobile_next/main.dart';

/// Smoke test for the residence-first navigation shell (§5): the five
/// primary destinations exist and switching between them doesn't crash.
void main() {
  testWidgets('shows all five primary destinations and can switch between them',
      (tester) async {
    await tester.pumpWidget(const ProviderScope(child: SupremeMobileApp()));
    await tester.pumpAndSettle();

    for (final label in ['Home', 'Spaces', 'Experiences', 'Now', 'More']) {
      expect(find.text(label), findsOneWidget);
    }

    await tester.tap(find.text('Spaces'));
    await tester.pumpAndSettle();
    expect(find.text('Spaces'), findsWidgets);

    await tester.tap(find.text('Experiences'));
    await tester.pumpAndSettle();
  });
}
