import 'provisioning.dart';

/// Minimum connection states for a registered panel (§10). Backed by a
/// heartbeat/session mechanism at the Hub, not a naive ping — this type is
/// just the projection the UI (Logs > Touch Panels, §11) renders. Modeled as
/// data returned by the Hub, never inferred client-side from "did the last
/// request succeed" (§H of the Phase 1-6 review).
enum PanelConnectionState { connected, disconnected }

class PanelRegistryEntry {
  final String panelId;
  final String displayName;
  final String? model;
  final String? firmwareVersion;
  final String projectId;
  final ControlScope scope;
  final String? roomId;
  final String? areaId; // floor/area id when scope is floor
  final PanelConnectionState connectionState;
  final DateTime lastSeen;
  final DateTime assignedAt;
  final int configurationVersion;
  final ProvisioningState provisioningState;
  final PanelIdentity identity;

  const PanelRegistryEntry({
    required this.panelId,
    required this.displayName,
    required this.projectId,
    required this.scope,
    required this.connectionState,
    required this.lastSeen,
    required this.assignedAt,
    required this.configurationVersion,
    required this.provisioningState,
    required this.identity,
    this.model,
    this.firmwareVersion,
    this.roomId,
    this.areaId,
  });
}

enum PanelEventKind {
  connected,
  disconnected,
  configurationUpdated,
  provisioned,
  assignmentChanged
}

class PanelEvent {
  final String panelId;
  final PanelEventKind kind;
  final DateTime at;
  final String? detail;
  const PanelEvent(
      {required this.panelId,
      required this.kind,
      required this.at,
      this.detail});
}

/// Read-side contract for the future Logs > Touch Panels view and panel
/// detail/diagnostics page (§11, §12, §13). The Hub is the source of truth —
/// this repository interface is what a real gateway client will implement;
/// nothing here is a duplicated local room database (§11).
abstract class PanelRegistryRepository {
  Future<List<PanelRegistryEntry>> listPanels();
  Future<List<PanelEvent>> panelHistory(String panelId);
}
