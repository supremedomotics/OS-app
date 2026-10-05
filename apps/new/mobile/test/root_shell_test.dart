import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_mobile_next/main.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// Smoke test for the residence-first navigation shell (§5), in the SupremeOS-10 information
/// architecture: Home · Spaces · Control · Experiences · Settings. The old `Now` / `More` shell is
/// gone (classified, not dropped — see `RootShell`'s doc comment).
/// "No LAN Hub found", answered at once — the real no-network outcome without this host's mDNS,
/// which a widget test's fake clock never lets finish. The connection then goes offline and the
/// residence screens say so.
class _NoLanDiscovery implements HubDiscovery {
  @override
  Future<Uri?> discoverLan({Duration timeout = const Duration(seconds: 3)}) async => null;

  @override
  Future<List<DiscoveredHub>> discoverAllLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      const [];
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('shows all five primary destinations and can switch between them',
      (tester) async {
    await tester.pumpWidget(const ProviderScope(child: SupremeMobileApp(home: RootShell())));
    await tester.pumpAndSettle();

    for (final label in ['Home', 'Spaces', 'Control', 'Experiences', 'Settings']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    // The previous information architecture no longer exists.
    expect(find.text('Now'), findsNothing);
    expect(find.text('More'), findsNothing);

    await tester.tap(find.text('Spaces'));
    await tester.pumpAndSettle();
    expect(find.text('Spaces'), findsWidgets);

    await tester.tap(find.text('Experiences'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('Control is a layer over the page, not a page: the page underneath stays',
      (tester) async {
    await tester.pumpWidget(ProviderScope(
        overrides: [platformDiscoveryProvider.overrideWithValue(_NoLanDiscovery())],
        child: const SupremeMobileApp(home: RootShell())));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Spaces'));
    await tester.pumpAndSettle();
    expect(find.text('Your residence isn’t reachable right now.'), findsOneWidget);

    await tester.tap(find.text('Control'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('control-layer')), findsOneWidget);
    // Still on Spaces underneath: Control never replaced the page (the layer says the same of its
    // own scope, so the message now appears twice).
    expect(find.text('Your residence isn’t reachable right now.'), findsNWidgets(2));

    await tester.tap(find.byKey(const ValueKey('control-close')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('control-layer')), findsNothing);
    expect(find.text('Your residence isn’t reachable right now.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the shell shows the mark of a residence that is not connected, not a fake state',
      (tester) async {
    await tester.pumpWidget(const ProviderScope(child: SupremeMobileApp(home: RootShell())));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('shell-presence')), findsOneWidget);
    expect(find.byKey(const ValueKey('shell-wordmark')), findsOneWidget);
  });
}
