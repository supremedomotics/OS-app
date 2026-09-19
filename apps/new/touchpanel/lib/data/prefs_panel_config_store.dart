import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// Persists the panel's locked assignment to disk so it survives app
/// restart, device reboot, and temporary network loss (§40). The Hub remains
/// authoritative — this is a boot-speed cache only, overwritten whenever the
/// Hub pushes a new configuration (§41).
class PrefsPanelConfigStore implements PanelConfigStore {
  static const _key = 'supreme_panel_config_v1';

  @override
  Future<PanelConfig?> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    if (raw == null) return null;
    final json = jsonDecode(raw) as Map<String, dynamic>;
    final assignmentJson = json['assignment'] as Map<String, dynamic>?;
    return PanelConfig(
      identity: PanelIdentity(
        panelId: json['panelId'] as String,
        deviceIdentity: json['deviceIdentity'] as String,
        macAddress: json['macAddress'] as String?,
      ),
      provisioningState:
          ProvisioningState.values.byName(json['provisioningState'] as String),
      assignment: assignmentJson == null
          ? null
          : PanelAssignment(
              scope:
                  ControlScope.values.byName(assignmentJson['scope'] as String),
              projectId: assignmentJson['projectId'] as String,
              configurationVersion:
                  assignmentJson['configurationVersion'] as int,
              assignedAreaId: assignmentJson['assignedAreaId'] as String?,
              assignedAreaName: assignmentJson['assignedAreaName'] as String?,
              assignedRoomId: assignmentJson['assignedRoomId'] as String?,
              assignedRoomName: assignmentJson['assignedRoomName'] as String?,
            ),
    );
  }

  @override
  Future<void> save(PanelConfig config) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
        _key,
        jsonEncode({
          'panelId': config.identity.panelId,
          'deviceIdentity': config.identity.deviceIdentity,
          'macAddress': config.identity.macAddress,
          'provisioningState': config.provisioningState.name,
          'assignment': config.assignment == null
              ? null
              : {
                  'scope': config.assignment!.scope.name,
                  'projectId': config.assignment!.projectId,
                  'configurationVersion':
                      config.assignment!.configurationVersion,
                  'assignedAreaId': config.assignment!.assignedAreaId,
                  'assignedAreaName': config.assignment!.assignedAreaName,
                  'assignedRoomId': config.assignment!.assignedRoomId,
                  'assignedRoomName': config.assignment!.assignedRoomName,
                },
        }));
  }

  @override
  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
  }
}
