import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';
import 'package:supreme_mobile_next/features/home/home_screen.dart';
import 'package:supreme_mobile_next/main.dart';

/// A [HubDiscovery] that resolves to "no LAN Hub found" immediately — the real, honest
/// no-network-available outcome, without depending on this test host's actual mDNS/network
/// stack (which is not guaranteed reachable in a sandboxed widget test).
class _NoLanDiscovery implements HubDiscovery {
  @override
  Future<Uri?> discoverLan({Duration timeout = const Duration(seconds: 3)}) async =>
      null;

  @override
  Future<List<DiscoveredHub>> discoverAllLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      const [];
}

/// §Phase13.4 Visual QA Remediation — regression coverage for QA-01, QA-02, QA-03, QA-04, QA-07.
/// (QA-05's own regression tests live in settings_navigation_test.dart.)
void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('Spaces shows an honest empty state, not a blank screen (§QA-01)',
      (tester) async {
    await tester.pumpWidget(const ProviderScope(child: SupremeMobileApp()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Spaces'));
    await tester.pumpAndSettle();

    expect(find.text('Spaces'), findsWidgets);
    expect(find.text('No Spaces yet'), findsOneWidget);
  });

  testWidgets(
      'Experiences shows its header and an honest empty state, not a blank screen (§QA-02)',
      (tester) async {
    await tester.pumpWidget(const ProviderScope(child: SupremeMobileApp()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Experiences'));
    await tester.pumpAndSettle();

    expect(find.text('Experiences'), findsWidgets);
    expect(find.text('No Experiences yet'), findsOneWidget);
  });

  testWidgets(
      'More renders every destination with an icon, and unimplemented ones say so (§QA-03/QA-04)',
      (tester) async {
    await tester.pumpWidget(const ProviderScope(child: SupremeMobileApp()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('More'));
    await tester.pumpAndSettle();

    for (final label in ['Devices', 'Automations', 'Settings', 'Professional Mode']) {
      expect(find.text(label), findsOneWidget);
    }
    // Unimplemented rows are honestly labeled, not silently identical to Settings.
    expect(find.text('Not available yet'), findsNWidgets(3));
    expect(find.byIcon(Icons.settings_outlined), findsOneWidget);

    // The one real destination still works.
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(AppBar, 'Settings'), findsOneWidget);
  });

  testWidgets('unimplemented More items do not navigate anywhere on tap (§QA-04)',
      (tester) async {
    await tester.pumpWidget(const ProviderScope(child: SupremeMobileApp()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('More'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Devices'));
    await tester.pumpAndSettle();

    // Still on More — no route was pushed.
    expect(find.text('Devices'), findsOneWidget);
    expect(find.text('Not available yet'), findsNWidgets(3));
  });

  testWidgets('offline Home status offers a real, working retry action (§QA-07)',
      (tester) async {
    // A real ConnectionManager whose discovery deterministically finds no LAN Hub and has no
    // remote transport configured — this is the genuine "offline, nothing to fall back to"
    // outcome ConnectionManager.start() already implements, not a stubbed-out status.
    final manager = ConnectionManager(
      discovery: _NoLanDiscovery(),
      makeLanTransport: (_) => throw UnimplementedError(),
    );
    await manager.start();

    await tester.pumpWidget(ProviderScope(
      overrides: [connectionManagerProvider.overrideWithValue(manager)],
      child: const MaterialApp(home: AdaptiveScope(child: HomeScreen())),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Offline'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);

    // Tapping it must not throw — it re-runs the real ConnectionManager.start() path.
    await tester.tap(find.text('Retry'));
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('Settings renders with no paired Home (§Settings-no-home)', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: SupremeMobileApp()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('More'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.widgetWithText(AppBar, 'Settings'), findsOneWidget);
  });

  testWidgets('Settings -> Home renders with a paired Home present (§Settings-with-home)',
      (tester) async {
    SharedPreferences.setMockInitialValues({
      'supreme_paired_homes_v1': jsonEncode([
        {
          'hubId': 'hub-1',
          'projectId': 'proj-1',
          'displayName': 'Test Home',
          'pairedAt': DateTime(2026).toIso8601String(),
          'lastUsedAt': null,
          'remoteAccessEnabled': false,
        }
      ]),
      'supreme_active_home_id_v1': 'hub-1',
    });

    await tester.pumpWidget(const ProviderScope(child: SupremeMobileApp()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('More'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Home'));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('Test Home'), findsOneWidget);
  });
}
