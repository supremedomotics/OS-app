import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:supreme_touchpanel/data/prefs_panel_config_store.dart';

/// Disk-backed counterpart to the in-memory provisioning tests in
/// apps/new/shared — proves the actual persistence mechanism the Touch Panel
/// ships with round-trips correctly (§40).
void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('save then load round-trips a room assignment exactly', () async {
    final store = PrefsPanelConfigStore();
    const config = PanelConfig(
      identity: PanelIdentity(
        panelId: 'panel-1',
        deviceIdentity: 'cert:panel-1',
        macAddress: 'AA:BB:CC:DD:EE:FF',
      ),
      provisioningState: ProvisioningState.provisioned,
      assignment: PanelAssignment(
        scope: ControlScope.room,
        projectId: 'proj-1',
        configurationVersion: 3,
        assignedRoomId: 'living-room',
      ),
    );

    await store.save(config);

    // A fresh store instance simulates a process/app restart reading the
    // same underlying disk-backed SharedPreferences.
    final restored = await PrefsPanelConfigStore().load();

    expect(restored, isNotNull);
    expect(restored!.isLocked, isTrue);
    expect(restored.identity.panelId, 'panel-1');
    expect(restored.identity.macAddress, 'AA:BB:CC:DD:EE:FF');
    expect(restored.assignment!.scope, ControlScope.room);
    expect(restored.assignment!.assignedRoomId, 'living-room');
    expect(restored.assignment!.configurationVersion, 3);
  });

  test('load returns null when nothing has been provisioned yet', () async {
    final restored = await PrefsPanelConfigStore().load();
    expect(restored, isNull);
  });

  test('clear removes the stored assignment', () async {
    final store = PrefsPanelConfigStore();
    await store.save(const PanelConfig(
      identity:
          PanelIdentity(panelId: 'panel-1', deviceIdentity: 'cert:panel-1'),
      provisioningState: ProvisioningState.provisioned,
      assignment: PanelAssignment(
        scope: ControlScope.wholeHome,
        projectId: 'proj-1',
        configurationVersion: 1,
      ),
    ));

    await store.clear();

    expect(await PrefsPanelConfigStore().load(), isNull);
  });
}
