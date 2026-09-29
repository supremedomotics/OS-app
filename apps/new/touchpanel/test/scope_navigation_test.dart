import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';
import 'package:supreme_touchpanel/provisioning/assigned_screen.dart';
import 'support/panel_rig.dart';

Future<PanelRig> _mount(WidgetTester tester, PanelAssignment assignment) async {
  final rig = PanelRig();
  final manager = ConnectionManager(
    discovery: const MockHubDiscovery(),
    makeLanTransport: (_) => MockHubTransport(),
  );
  await rig.mount(
    tester,
    AssignedScreen(
      config: PanelConfig(
        identity: const PanelIdentity(panelId: 'p1', deviceIdentity: 'cert:p1'),
        provisioningState: ProvisioningState.provisioned,
        assignment: assignment,
      ),
      fetchAreas: rig.residence.areas,
      connection: manager,
      residence: rig.residence,
    ),
  );
  await tester.pump(const Duration(milliseconds: 600));
  await rig.settle(tester);
  return rig;
}

void main() {
  group('scope navigation restrictions (§Phase8-18)', () {
    testWidgets(
        'ROOM scope: opens directly into its room, no navigation at all',
        (tester) async {
      await _mount(tester, const PanelAssignment(
          scope: ControlScope.room,
          projectId: 'proj-1',
          configurationVersion: 1,
          assignedRoomId: 'living',
          assignedRoomName: 'Living Room',
        ));

      expect(find.text('Living Room'), findsOneWidget);
      // No room switcher for any other room — a Room Control panel must not
      // expose generic room-selection navigation (§Phase8-1). (ChoiceChip
      // itself still appears — LightingControl/ShadesControl use it for
      // their own mood/position options, which is unrelated to navigation.)
      expect(find.text('Dining Room'), findsNothing);
      expect(find.text('Kitchen'), findsNothing);
      expect(find.text('Master Bedroom'), findsNothing);
    });

    testWidgets(
        'FLOOR scope: room switcher includes only rooms on the assigned floor',
        (tester) async {
      await _mount(tester, const PanelAssignment(
          scope: ControlScope.floor,
          projectId: 'proj-1',
          configurationVersion: 1,
          assignedAreaId: '0',
          assignedAreaName: 'Ground Floor',
        ));

      // Ground-floor rooms are reachable...
      expect(find.text('Living Room'), findsWidgets);
      expect(find.text('Dining Room'), findsOneWidget);
      expect(find.text('Kitchen'), findsOneWidget);
      // ...but a room on a DIFFERENT floor must not appear — this is not a
      // generic room picker, it's scoped navigation (§Phase8-18).
      expect(find.text('Master Bedroom'), findsNothing);
    });

    testWidgets(
        'WHOLE HOME scope: room switcher includes every room in the project',
        (tester) async {
      await _mount(tester, const PanelAssignment(
          scope: ControlScope.wholeHome,
          projectId: 'proj-1',
          configurationVersion: 1,
        ));

      expect(find.text('Living Room'), findsWidgets);
      expect(find.text('Dining Room'), findsOneWidget);
      expect(find.text('Kitchen'), findsOneWidget);
      expect(find.text('Master Bedroom'), findsOneWidget);
    });

    testWidgets(
        'switching rooms within FLOOR scope shows that room\'s own experience',
        (tester) async {
      await _mount(tester, const PanelAssignment(
          scope: ControlScope.floor,
          projectId: 'proj-1',
          configurationVersion: 1,
          assignedAreaId: '0',
          assignedAreaName: 'Ground Floor',
        ));

      await tester.tap(find.widgetWithText(ChoiceChip, 'Kitchen'));
      await tester.pumpAndSettle();

      // The room experience below the switcher is now Kitchen's, not the
      // default first room's.
      expect(find.byType(RoomHeader), findsOneWidget);
      final header = tester.widget<RoomHeader>(find.byType(RoomHeader));
      expect(header.roomName, 'Kitchen');
    });
  });

  group('provisioning lock — no reassignment control at any scope (§19)', () {
    for (final entry in {
      'ROOM': const PanelAssignment(
        scope: ControlScope.room,
        projectId: 'proj-1',
        configurationVersion: 1,
        assignedRoomId: 'living',
        assignedRoomName: 'Living Room',
      ),
      'FLOOR': const PanelAssignment(
        scope: ControlScope.floor,
        projectId: 'proj-1',
        configurationVersion: 1,
        assignedAreaId: '0',
        assignedAreaName: 'Ground Floor',
      ),
      'WHOLE HOME': const PanelAssignment(
        scope: ControlScope.wholeHome,
        projectId: 'proj-1',
        configurationVersion: 1,
      ),
    }.entries) {
      testWidgets('${entry.key} scope exposes no Change/Reassign control',
          (tester) async {
        await _mount(tester, entry.value);

        expect(find.textContaining('Change Room'), findsNothing);
        expect(find.textContaining('Change Floor'), findsNothing);
        expect(find.textContaining('Change Scope'), findsNothing);
        expect(find.textContaining('Reassign'), findsNothing);
      });
    }
  });
}
