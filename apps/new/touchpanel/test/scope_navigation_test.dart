import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';
import 'package:supreme_touchpanel/provisioning/assigned_screen.dart';

const _allAreas = [
  AreaSummary(id: 'living-room', name: 'Living Room', floorId: 'ground'),
  AreaSummary(id: 'dining', name: 'Dining', floorId: 'ground'),
  AreaSummary(id: 'kitchen', name: 'Kitchen', floorId: 'ground'),
  AreaSummary(id: 'master-bedroom', name: 'Master Bedroom', floorId: 'first'),
];

Widget _assignedAt(Size size, PanelAssignment assignment) {
  final manager = ConnectionManager(
    discovery: const MockHubDiscovery(),
    makeLanTransport: (_) => MockHubTransport(),
  );
  return MediaQuery(
    data: MediaQueryData(size: size),
    child: MaterialApp(
      theme: buildSupremeTheme(),
      home: AdaptiveScope(
        child: AssignedScreen(
          config: PanelConfig(
            identity:
                const PanelIdentity(panelId: 'p1', deviceIdentity: 'cert:p1'),
            provisioningState: ProvisioningState.provisioned,
            assignment: assignment,
          ),
          fetchAreas: () async => _allAreas,
          connection: manager,
        ),
      ),
    ),
  );
}

void main() {
  group('scope navigation restrictions (§Phase8-18)', () {
    testWidgets(
        'ROOM scope: opens directly into its room, no navigation at all',
        (tester) async {
      await tester.pumpWidget(_assignedAt(
        const Size(800, 1280),
        const PanelAssignment(
          scope: ControlScope.room,
          projectId: 'proj-1',
          configurationVersion: 1,
          assignedRoomId: 'living-room',
          assignedRoomName: 'Living Room',
        ),
      ));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 600));

      expect(find.text('Living Room'), findsOneWidget);
      // No room switcher for any other room — a Room Control panel must not
      // expose generic room-selection navigation (§Phase8-1). (ChoiceChip
      // itself still appears — LightingControl/ShadesControl use it for
      // their own mood/position options, which is unrelated to navigation.)
      expect(find.text('Dining'), findsNothing);
      expect(find.text('Kitchen'), findsNothing);
      expect(find.text('Master Bedroom'), findsNothing);
    });

    testWidgets(
        'FLOOR scope: room switcher includes only rooms on the assigned floor',
        (tester) async {
      await tester.pumpWidget(_assignedAt(
        const Size(800, 1280),
        const PanelAssignment(
          scope: ControlScope.floor,
          projectId: 'proj-1',
          configurationVersion: 1,
          assignedAreaId: 'ground',
          assignedAreaName: 'Ground Floor',
        ),
      ));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 600));

      // Ground-floor rooms are reachable...
      expect(find.text('Living Room'), findsWidgets);
      expect(find.text('Dining'), findsOneWidget);
      expect(find.text('Kitchen'), findsOneWidget);
      // ...but a room on a DIFFERENT floor must not appear — this is not a
      // generic room picker, it's scoped navigation (§Phase8-18).
      expect(find.text('Master Bedroom'), findsNothing);
    });

    testWidgets(
        'WHOLE HOME scope: room switcher includes every room in the project',
        (tester) async {
      await tester.pumpWidget(_assignedAt(
        const Size(800, 1280),
        const PanelAssignment(
          scope: ControlScope.wholeHome,
          projectId: 'proj-1',
          configurationVersion: 1,
        ),
      ));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 600));

      expect(find.text('Living Room'), findsWidgets);
      expect(find.text('Dining'), findsOneWidget);
      expect(find.text('Kitchen'), findsOneWidget);
      expect(find.text('Master Bedroom'), findsOneWidget);
    });

    testWidgets(
        'switching rooms within FLOOR scope shows that room\'s own experience',
        (tester) async {
      await tester.pumpWidget(_assignedAt(
        const Size(800, 1280),
        const PanelAssignment(
          scope: ControlScope.floor,
          projectId: 'proj-1',
          configurationVersion: 1,
          assignedAreaId: 'ground',
          assignedAreaName: 'Ground Floor',
        ),
      ));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 600));

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
        assignedRoomId: 'living-room',
        assignedRoomName: 'Living Room',
      ),
      'FLOOR': const PanelAssignment(
        scope: ControlScope.floor,
        projectId: 'proj-1',
        configurationVersion: 1,
        assignedAreaId: 'ground',
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
        await tester
            .pumpWidget(_assignedAt(const Size(800, 1280), entry.value));
        await tester.pumpAndSettle();
        await tester.pump(const Duration(milliseconds: 600));

        expect(find.textContaining('Change Room'), findsNothing);
        expect(find.textContaining('Change Floor'), findsNothing);
        expect(find.textContaining('Change Scope'), findsNothing);
        expect(find.textContaining('Reassign'), findsNothing);
      });
    }
  });
}
