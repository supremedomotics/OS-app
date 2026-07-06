import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_mobile/app.dart';
import 'package:supreme_mobile/providers.dart';

void main() {
  testWidgets('app boots to the Supreme-branded login (no backend visible)', (tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final prefs = await SharedPreferences.getInstance();
    await tester.pumpWidget(ProviderScope(
      overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      child: const SupremeApp(),
    ));
    await tester.pump();

    // The entry surface is a Supreme account login — never any HA branding.
    expect(find.text('Supreme'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
    expect(find.textContaining('Home Assistant'), findsNothing);
  });
}
