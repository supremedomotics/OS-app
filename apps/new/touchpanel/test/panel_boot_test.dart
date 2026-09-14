import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_touchpanel/main.dart';

/// Exercises the real boot widget end-to-end against the real (mocked-out
/// SharedPreferences) persistence path — this is the actual §40 acceptance
/// test: a locked assignment must survive an app restart, and the assigned
/// screen must never expose a way to change it (§7).
void main() {
  // The mock Hub connection resolves after a short delay (see
  // MockHubDiscovery) — advance the fake clock past it so no test finishes
  // with a dangling timer.
  const settleConnection = Duration(milliseconds: 1000);

  testWidgets('fresh panel enters first-boot provisioning', (tester) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(const SupremeTouchPanelApp());
    await tester.pumpAndSettle();
    await tester.pump(settleConnection);

    expect(
        find.text('How should this panel control your home?'), findsOneWidget);
    expect(find.text('Room Control'), findsOneWidget);
  });

  testWidgets(
      'provisioned panel restores its locked room across an app restart (§40)',
      (tester) async {
    SharedPreferences.setMockInitialValues({});

    // First boot: provision as Room Control -> Living Room.
    await tester.pumpWidget(const SupremeTouchPanelApp());
    await tester.pumpAndSettle();
    await tester.tap(find.text('Room Control'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Living Room'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();
    await tester.pump(settleConnection);

    // Homeowner UI shows the human display name, never the raw machine id
    // (§Phase7.1 — regression for the id-leak bug found during Phase 7
    // visual validation).
    expect(find.text('Living Room'), findsOneWidget);
    expect(find.text('living-room'), findsNothing);
    // The locked screen must never expose a reassignment control (§19).
    expect(find.textContaining('Change Room'), findsNothing);
    expect(find.textContaining('Change Floor'), findsNothing);
    expect(find.textContaining('Change Scope'), findsNothing);
    expect(find.textContaining('Reassign'), findsNothing);

    // Simulate an app/device restart: tear down and remount a fresh widget
    // tree, backed by the same (persisted) SharedPreferences store.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(const SupremeTouchPanelApp());
    await tester.pumpAndSettle();
    await tester.pump(settleConnection);

    // Must go straight back to the same room — never re-ask, never show a
    // different room, never fall back to a generic dashboard.
    expect(find.text('Living Room'), findsOneWidget);
    expect(find.text('How should this panel control your home?'), findsNothing);
  });
}
