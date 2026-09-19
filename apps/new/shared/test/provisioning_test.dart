import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

class InMemoryPanelConfigStore implements PanelConfigStore {
  PanelConfig? _config;
  @override
  Future<PanelConfig?> load() async => _config;
  @override
  Future<void> save(PanelConfig config) async => _config = config;
  @override
  Future<void> clear() async => _config = null;
}

void main() {
  group('ProvisioningController', () {
    late InMemoryPanelConfigStore store;
    late ProvisioningController controller;

    setUp(() {
      store = InMemoryPanelConfigStore();
      controller = ProvisioningController(
        store: store,
        fetchAreas: () async => const [
          AreaSummary(id: 'living-room', name: 'Living Room'),
          AreaSummary(id: 'kitchen', name: 'Kitchen'),
        ],
        confirmWithHub: (assignment) async => PanelConfig(
          identity:
              const PanelIdentity(panelId: 'p1', deviceIdentity: 'cert:p1'),
          provisioningState: ProvisioningState.provisioned,
          assignment: assignment,
        ),
      );
    });

    test('fresh panel has no stored assignment', () async {
      expect(await controller.restoreOrStartProvisioning(), isNull);
    });

    test('completing provisioning persists a locked assignment', () async {
      final config =
          await controller.completeProvisioning(const PanelAssignment(
        scope: ControlScope.room,
        projectId: 'proj-1',
        configurationVersion: 1,
        assignedRoomId: 'living-room',
      ));

      expect(config.isLocked, isTrue);
      expect(config.assignment!.assignedRoomId, 'living-room');
    });

    test('reboot restores the same assignment without re-asking (§40)',
        () async {
      await controller.completeProvisioning(const PanelAssignment(
        scope: ControlScope.room,
        projectId: 'proj-1',
        configurationVersion: 1,
        assignedRoomId: 'kitchen',
      ));

      // Simulate app restart: fresh controller, same store.
      final restarted = ProvisioningController(
        store: store,
        fetchAreas: controller.fetchAreas,
        confirmWithHub: controller.confirmWithHub,
      );

      final restored = await restarted.restoreOrStartProvisioning();
      expect(restored, isNotNull);
      expect(restored!.isLocked, isTrue);
      expect(restored.assignment!.assignedRoomId, 'kitchen');
    });

    test('room scope requires a room id', () {
      // Not `const` here: a const constructor's failing assert is a
      // compile-time error, not a runtime throw — this test needs the
      // assertion to fire at runtime for throwsA to observe it.
      expect(
        () => PanelAssignment(
          scope: ControlScope.room,
          projectId: 'proj-1',
          configurationVersion: 1,
        ),
        throwsA(isA<AssertionError>()),
      );
    });

    test('Hub-pushed reassignment overwrites the local cache (§41)', () async {
      await controller.completeProvisioning(const PanelAssignment(
        scope: ControlScope.room,
        projectId: 'proj-1',
        configurationVersion: 1,
        assignedRoomId: 'living-room',
      ));

      await controller.applyHubPushedReassignment(const PanelConfig(
        identity: const PanelIdentity(panelId: 'p1', deviceIdentity: 'cert:p1'),
        provisioningState: ProvisioningState.provisioned,
        assignment: const PanelAssignment(
          scope: ControlScope.room,
          projectId: 'proj-1',
          configurationVersion: 2,
          assignedRoomId: 'kitchen',
        ),
      ));

      final config = await store.load();
      expect(config!.assignment!.assignedRoomId, 'kitchen');
      expect(config.assignment!.configurationVersion, 2);
    });

    test(
        'the Hub response is authoritative, not the client-requested assignment '
        '(§A — a modified client cannot self-escalate ROOM -> WHOLE HOME)',
        () async {
      // A tampered/malicious client requests whole-home control...
      final requested = const PanelAssignment(
        scope: ControlScope.wholeHome,
        projectId: 'proj-1',
        configurationVersion: 1,
      );

      // ...but the Hub is the one deciding what actually gets persisted. Model
      // that decision explicitly: the Hub downgrades the request to the panel's
      // real entitlement (Room Control) rather than trusting the request as-is.
      final hubEnforcingController = ProvisioningController(
        store: store,
        fetchAreas: controller.fetchAreas,
        confirmWithHub: (_) async => const PanelConfig(
          identity:
              const PanelIdentity(panelId: 'p1', deviceIdentity: 'cert:p1'),
          provisioningState: ProvisioningState.provisioned,
          assignment: const PanelAssignment(
            scope: ControlScope.room,
            projectId: 'proj-1',
            configurationVersion: 1,
            assignedRoomId: 'living-room',
          ),
        ),
      );

      final result =
          await hubEnforcingController.completeProvisioning(requested);

      // The persisted/returned config reflects the Hub's decision, not the
      // client's request.
      expect(result.assignment!.scope, ControlScope.room);
      expect(result.assignment!.assignedRoomId, 'living-room');
      final persisted = await store.load();
      expect(persisted!.assignment!.scope, isNot(ControlScope.wholeHome));
    });
  });
}
