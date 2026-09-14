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
  group('DeterministicHmacConfigVerifier (§Phase9-10)', () {
    const verifier = DeterministicHmacConfigVerifier();

    test('a correctly signed, newer-or-equal-version config verifies', () {
      final result = verifier.verify(
        incoming: const SignedPanelConfig(
          assignment: PanelAssignment(
            scope: ControlScope.room,
            projectId: 'proj-1',
            configurationVersion: 2,
            assignedRoomId: 'living-room',
          ),
          provisioningState: ProvisioningState.provisioned,
          configurationVersion: 2,
          signature: 'test-hub-signature-v1',
        ),
        currentConfigurationVersion: 1,
      );
      expect(result, ConfigVerificationResult.verified);
    });

    test('an invalid signature is rejected regardless of version', () {
      final result = verifier.verify(
        incoming: const SignedPanelConfig(
          assignment: PanelAssignment(
            scope: ControlScope.room,
            projectId: 'proj-1',
            configurationVersion: 5,
            assignedRoomId: 'living-room',
          ),
          provisioningState: ProvisioningState.provisioned,
          configurationVersion: 5,
          signature: 'forged-by-a-local-attacker',
        ),
        currentConfigurationVersion: 1,
      );
      expect(result, ConfigVerificationResult.rejectedInvalidSignature);
    });

    test(
        'a validly signed but older/stale version is rejected (replay protection)',
        () {
      final result = verifier.verify(
        incoming: const SignedPanelConfig(
          assignment: PanelAssignment(
            scope: ControlScope.room,
            projectId: 'proj-1',
            configurationVersion: 1,
            assignedRoomId: 'living-room',
          ),
          provisioningState: ProvisioningState.provisioned,
          configurationVersion: 1,
          signature: 'test-hub-signature-v1',
        ),
        currentConfigurationVersion: 3,
      );
      expect(result, ConfigVerificationResult.rejectedStaleVersion);
    });
  });

  group('ProvisioningController.revalidateAgainstHub (§Phase9-9)', () {
    late InMemoryPanelConfigStore store;
    late ProvisioningController controller;

    setUp(() {
      store = InMemoryPanelConfigStore();
      controller = ProvisioningController(
        store: store,
        fetchAreas: () async => const [],
        confirmWithHub: (a) async => PanelConfig(
          identity:
              const PanelIdentity(panelId: 'p1', deviceIdentity: 'cert:p1'),
          provisioningState: ProvisioningState.provisioned,
          assignment: a,
        ),
      );
    });

    test('adopts a verified Hub-authoritative config, overwriting the cache',
        () async {
      await controller.completeProvisioning(const PanelAssignment(
        scope: ControlScope.room,
        projectId: 'proj-1',
        configurationVersion: 1,
        assignedRoomId: 'living-room',
        assignedRoomName: 'Living Room',
      ));

      final outcome = await controller.revalidateAgainstHub(
        fetchAuthoritativeConfig: () async => const SignedPanelConfig(
          assignment: PanelAssignment(
            scope: ControlScope.room,
            projectId: 'proj-1',
            configurationVersion: 2,
            assignedRoomId: 'kitchen',
            assignedRoomName: 'Kitchen',
          ),
          provisioningState: ProvisioningState.provisioned,
          configurationVersion: 2,
          signature: 'test-hub-signature-v1',
        ),
        verifier: const DeterministicHmacConfigVerifier(),
      );

      expect(outcome.result, ConfigVerificationResult.verified);
      final persisted = await store.load();
      expect(persisted!.assignment!.assignedRoomId, 'kitchen');
    });

    test(
        'a locally-edited/forged config (bad signature) is rejected and the cache is '
        'left untouched (§ a cached JSON file must not be able to change scope)',
        () async {
      await controller.completeProvisioning(const PanelAssignment(
        scope: ControlScope.room,
        projectId: 'proj-1',
        configurationVersion: 1,
        assignedRoomId: 'living-room',
        assignedRoomName: 'Living Room',
      ));

      final outcome = await controller.revalidateAgainstHub(
        // Simulates an attacker who edited the cache/response to claim
        // Whole Home control.
        fetchAuthoritativeConfig: () async => const SignedPanelConfig(
          assignment: PanelAssignment(
            scope: ControlScope.wholeHome,
            projectId: 'proj-1',
            configurationVersion: 99,
          ),
          provisioningState: ProvisioningState.provisioned,
          configurationVersion: 99,
          signature: 'not-a-real-hub-signature',
        ),
        verifier: const DeterministicHmacConfigVerifier(),
      );

      expect(outcome.result, ConfigVerificationResult.rejectedInvalidSignature);
      final persisted = await store.load();
      expect(persisted!.assignment!.scope, ControlScope.room);
      expect(persisted.assignment!.assignedRoomId, 'living-room');
    });

    test('a stale-version response does not roll the panel backwards',
        () async {
      await controller.completeProvisioning(const PanelAssignment(
        scope: ControlScope.room,
        projectId: 'proj-1',
        configurationVersion: 5,
        assignedRoomId: 'living-room',
        assignedRoomName: 'Living Room',
      ));

      final outcome = await controller.revalidateAgainstHub(
        fetchAuthoritativeConfig: () async => const SignedPanelConfig(
          assignment: PanelAssignment(
            scope: ControlScope.room,
            projectId: 'proj-1',
            configurationVersion: 3,
            assignedRoomId: 'dining',
          ),
          provisioningState: ProvisioningState.provisioned,
          configurationVersion: 3,
          signature: 'test-hub-signature-v1',
        ),
        verifier: const DeterministicHmacConfigVerifier(),
      );

      expect(outcome.result, ConfigVerificationResult.rejectedStaleVersion);
      final persisted = await store.load();
      expect(persisted!.assignment!.assignedRoomId, 'living-room');
      expect(persisted.assignment!.configurationVersion, 5);
    });
  });

  group('DeviceIdentity (§Phase9-11)', () {
    test('generateAndPersist creates a stable, retrievable identity', () async {
      final store =
          InMemoryDeviceIdentityStore(idGenerator: () => 'panel-fixed-id');
      expect(await store.load(), isNull);

      final identity = await store.generateAndPersist();
      expect(identity.deviceId, 'panel-fixed-id');

      final reloaded = await store.load();
      expect(reloaded, isNotNull);
      expect(reloaded!.deviceId, identity.deviceId);
    });
  });

  group('PanelHeartbeatMonitor (§Phase9-18)', () {
    test('reports connected within the grace period after a heartbeat', () {
      final monitor =
          PanelHeartbeatMonitor(gracePeriod: const Duration(seconds: 30));
      final t0 = DateTime(2026, 1, 1, 12, 0, 0);
      monitor.recordHeartbeat(t0);

      expect(monitor.connectionStateAt(t0.add(const Duration(seconds: 10))),
          PanelConnectionState.connected);
    });

    test('one missed beat within the grace period does not mean disconnected',
        () {
      final monitor =
          PanelHeartbeatMonitor(gracePeriod: const Duration(seconds: 30));
      final t0 = DateTime(2026, 1, 1, 12, 0, 0);
      monitor.recordHeartbeat(t0);

      // A heartbeat that would normally arrive at +15s didn't — but we're
      // still within the 30s grace period.
      expect(monitor.connectionStateAt(t0.add(const Duration(seconds: 20))),
          PanelConnectionState.connected);
    });

    test('reports disconnected once the grace period has elapsed', () {
      final monitor =
          PanelHeartbeatMonitor(gracePeriod: const Duration(seconds: 30));
      final t0 = DateTime(2026, 1, 1, 12, 0, 0);
      monitor.recordHeartbeat(t0);

      expect(monitor.connectionStateAt(t0.add(const Duration(seconds: 31))),
          PanelConnectionState.disconnected);
    });

    test('a panel that never sent a heartbeat is disconnected', () {
      final monitor = PanelHeartbeatMonitor();
      expect(monitor.connectionStateAt(DateTime.now()),
          PanelConnectionState.disconnected);
    });

    test('lastSeen tracks the most recent heartbeat', () {
      final monitor = PanelHeartbeatMonitor();
      final t0 = DateTime(2026, 1, 1, 12, 0, 0);
      final t1 = t0.add(const Duration(seconds: 10));
      monitor.recordHeartbeat(t0);
      monitor.recordHeartbeat(t1);
      expect(monitor.lastSeen, t1);
    });
  });
}
