import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';
import 'package:supreme_mobile_next/features/settings/home_settings_screen.dart';
import 'package:supreme_mobile_next/features/settings/paired_home_controller.dart';

/// Widget coverage for Settings → Home (§Phase12.1 §28) — Mobile/Tablet only. Nothing here is
/// imported by or run against `apps/new/touchpanel` (§20's exclusion is structural: this
/// screen doesn't exist in that package at all).
void main() {
  Widget wrap(Widget child) => MaterialApp(home: AdaptiveScope(child: child));

  testWidgets(
      'shows "no Home paired yet" and an Add Home action on first install (§23)',
      (tester) async {
    final controller = PairedHomeController(InMemoryPairedHomeStore());
    await tester.pumpWidget(wrap(HomeSettingsScreen(
      controller: controller,
      onPair: (_) async => throw UnimplementedError(),
    )));
    await tester.pumpAndSettle();

    expect(find.text('No Home paired yet'), findsOneWidget);
    expect(find.text('+ Add Home'), findsOneWidget);
  });

  testWidgets('lists multiple paired Homes by their display name',
      (tester) async {
    final store = InMemoryPairedHomeStore();
    final manager = PairedHomeManager(store);
    await manager.load();
    await manager.addHome(
        hubId: 'hub-a', projectId: 'proj-a', displayName: 'Sea View Residence');
    await manager.addHome(
        hubId: 'hub-b', projectId: 'proj-b', displayName: 'Weekend Home');

    final controller = PairedHomeController(store);
    await tester.pumpWidget(wrap(HomeSettingsScreen(
      controller: controller,
      onPair: (_) async => throw UnimplementedError(),
    )));
    await tester.pumpAndSettle();

    expect(find.text('Sea View Residence'), findsOneWidget);
    expect(find.text('Weekend Home'), findsOneWidget);
    // No raw technical identifiers shown to a normal homeowner (§4).
    expect(find.textContaining('hub-a'), findsNothing);
    expect(find.textContaining('hub-b'), findsNothing);
  });

  testWidgets(
      'the active Home shows a selected indicator; tapping another switches it',
      (tester) async {
    final store = InMemoryPairedHomeStore();
    final manager = PairedHomeManager(store);
    await manager.load();
    await manager.addHome(
        hubId: 'hub-a', projectId: 'proj-a', displayName: 'Home A');
    await manager.addHome(
        hubId: 'hub-b', projectId: 'proj-b', displayName: 'Home B');

    final controller = PairedHomeController(store);
    await tester.pumpWidget(wrap(HomeSettingsScreen(
      controller: controller,
      onPair: (_) async => throw UnimplementedError(),
    )));
    await tester.pumpAndSettle();

    expect(controller.activeHomeId, 'hub-a');
    expect(find.byIcon(Icons.check_circle), findsOneWidget);

    await tester.tap(find.text('Home B'));
    await tester.pumpAndSettle();

    expect(controller.activeHomeId, 'hub-b');
  });

  testWidgets('editing a Home name updates the list immediately',
      (tester) async {
    final store = InMemoryPairedHomeStore();
    final manager = PairedHomeManager(store);
    await manager.load();
    await manager.addHome(
        hubId: 'hub-a', projectId: 'proj-a', displayName: 'Old Name');

    final controller = PairedHomeController(store);
    await tester.pumpWidget(wrap(HomeSettingsScreen(
      controller: controller,
      onPair: (_) async => throw UnimplementedError(),
    )));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.edit_outlined));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Sea View Residence');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(find.text('Sea View Residence'), findsOneWidget);
    expect(find.text('Old Name'), findsNothing);
  });

  testWidgets('rejects an empty Home name and keeps the dialog open',
      (tester) async {
    final store = InMemoryPairedHomeStore();
    final manager = PairedHomeManager(store);
    await manager.load();
    await manager.addHome(
        hubId: 'hub-a', projectId: 'proj-a', displayName: 'Original');

    final controller = PairedHomeController(store);
    await tester.pumpWidget(wrap(HomeSettingsScreen(
      controller: controller,
      onPair: (_) async => throw UnimplementedError(),
    )));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.edit_outlined));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '   ');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(find.text('Home name cannot be empty'), findsOneWidget);
    expect(controller.homes.single.displayName, 'Original');
  });

  testWidgets(
      'removing a Home asks for confirmation and only removes that Home',
      (tester) async {
    final store = InMemoryPairedHomeStore();
    final manager = PairedHomeManager(store);
    await manager.load();
    await manager.addHome(
        hubId: 'hub-a', projectId: 'proj-a', displayName: 'Home A');
    await manager.addHome(
        hubId: 'hub-b', projectId: 'proj-b', displayName: 'Home B');

    final controller = PairedHomeController(store);
    await tester.pumpWidget(wrap(HomeSettingsScreen(
      controller: controller,
      onPair: (_) async => throw UnimplementedError(),
    )));
    await tester.pumpAndSettle();

    final deleteButtons = find.byIcon(Icons.delete_outline);
    await tester.tap(deleteButtons.first);
    await tester.pumpAndSettle();
    expect(find.text('Forget this Home?'), findsOneWidget);

    await tester.tap(find.text('Forget Home'));
    await tester.pumpAndSettle();

    expect(controller.homes, hasLength(1));
    expect(find.text('Home B'), findsOneWidget);
  });

  testWidgets(
      'adding a Home runs the real pairing handler, then asks for a display name',
      (tester) async {
    final controller = PairedHomeController(InMemoryPairedHomeStore());
    var pairedWithCode = '';
    await tester.pumpWidget(wrap(HomeSettingsScreen(
      controller: controller,
      onPair: (code) async {
        pairedWithCode = code;
        return const PairHomeResult(
            hubId: 'hub-new',
            projectId: 'proj-new',
            suggestedDisplayName: 'Villa');
      },
    )));
    await tester.pumpAndSettle();

    await tester.tap(find.text('+ Add Home'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '123456');
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    expect(pairedWithCode, '123456');
    expect(find.text('Name your Home'), findsOneWidget);
    expect(find.text('Villa'), findsWidgets); // prefilled suggestion

    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(controller.homes.single.hubId, 'hub-new');
    expect(controller.homes.single.displayName, 'Villa');
  });
}
