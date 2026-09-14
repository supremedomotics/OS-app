import 'config_integrity.dart';

/// Fixed control scope a Touch Panel is provisioned with (§4, §6). Once set,
/// a panel cannot change this from its own UI (§7) — only the Hub, through a
/// future authorized management surface, can.
enum ControlScope { room, floor, wholeHome }

enum ProvisioningState {
  unprovisioned,
  provisioning,
  provisioned,
  reprovisioning
}

/// Persistent identity for a Touch Panel (§8). MAC address is at most an
/// additional binding signal, never sufficient authentication on its own —
/// `deviceIdentity` is expected to be a real cryptographic identity (e.g. a
/// keypair-backed device cert) issued during provisioning, mirroring the
/// repository's existing auth architecture (`services/identity`).
class PanelIdentity {
  final String panelId;
  final String deviceIdentity;
  final String? macAddress;
  const PanelIdentity(
      {required this.panelId, required this.deviceIdentity, this.macAddress});
}

/// The authoritative assignment record (§6, §9). This is what the Hub stores
/// and what a reboot must restore verbatim (§40) — never re-derived from
/// local guesswork.
///
/// (§Phase7.1) Machine IDs are for the system, display names are for
/// humans: `assignedRoomId`/`assignedAreaId` are the Hub's stable
/// identifiers, `assignedRoomName`/`assignedAreaName` are what a homeowner
/// actually sees. Both come from the SAME Hub-authoritative source (the
/// `AreaSummary` the installer picked during provisioning, or a future
/// Hub-pushed reassignment) — a display name is never invented or slugified
/// client-side from the id.
class PanelAssignment {
  final ControlScope scope;
  final String? assignedAreaId; // floor
  final String? assignedAreaName;
  final String? assignedRoomId; // room
  final String? assignedRoomName;
  final String projectId;
  final int configurationVersion;

  const PanelAssignment({
    required this.scope,
    required this.projectId,
    required this.configurationVersion,
    this.assignedAreaId,
    this.assignedAreaName,
    this.assignedRoomId,
    this.assignedRoomName,
  }) : assert(
          scope != ControlScope.room || assignedRoomId != null,
          'room scope requires assignedRoomId',
        );

  /// The single homeowner-facing label for this assignment, regardless of
  /// scope — never a raw id. Falls back to the id only if a name genuinely
  /// wasn't supplied (a Hub/data gap to fix upstream, not something the UI
  /// should silently paper over further).
  String get displayName => switch (scope) {
        ControlScope.room => assignedRoomName ?? assignedRoomId ?? 'Room',
        ControlScope.floor => assignedAreaName ?? assignedAreaId ?? 'Floor',
        ControlScope.wholeHome => 'Whole Home',
      };
}

class PanelConfig {
  final PanelIdentity identity;
  final ProvisioningState provisioningState;
  final PanelAssignment? assignment; // null until provisioned
  const PanelConfig({
    required this.identity,
    required this.provisioningState,
    this.assignment,
  });

  bool get isLocked => provisioningState == ProvisioningState.provisioned;
}

/// Where the panel keeps its last-known-good assignment so it boots straight
/// back into the correct scope without re-asking the homeowner, even offline
/// (§40 — the critical reboot-persistence acceptance test). The Hub remains
/// authoritative; this is a read-through cache the Hub can overwrite when it
/// pushes a reassignment (§41).
abstract class PanelConfigStore {
  Future<PanelConfig?> load();
  Future<void> save(PanelConfig config);
  Future<void> clear();
}

/// Drives the first-boot provisioning flow (§6) and the ongoing
/// assignment-lock / reassignment-acceptance behavior (§7, §41). This is the
/// single place that flow lives — screens render off [state], they never
/// implement the flow themselves.
class ProvisioningController {
  final PanelConfigStore store;
  final Future<List<AreaSummary>> Function()
      fetchAreas; // Hub-authoritative, never hardcoded (§6)
  final Future<PanelConfig> Function(PanelAssignment assignment) confirmWithHub;

  ProvisioningController({
    required this.store,
    required this.fetchAreas,
    required this.confirmWithHub,
  });

  /// Called on every app start. Restores the locked assignment if present;
  /// otherwise starts fresh provisioning (§40).
  Future<PanelConfig?> restoreOrStartProvisioning() => store.load();

  Future<PanelConfig> completeProvisioning(PanelAssignment assignment) async {
    final confirmed = await confirmWithHub(assignment);
    await store.save(confirmed);
    return confirmed;
  }

  /// Applied when the Hub pushes a reassignment out-of-band (§41) — e.g. over
  /// the live event stream. Never triggered from in-panel UI.
  Future<void> applyHubPushedReassignment(PanelConfig next) => store.save(next);

  /// The mandatory revalidation flow (§Phase9-9): boot shows the cached
  /// config immediately (the caller does that via [restoreOrStartProvisioning]
  /// before this ever runs — this method is NOT on the boot-blocking path),
  /// then once connected to the Hub, the panel fetches the Hub's
  /// authoritative configuration, verifies it, and only a VERIFIED result
  /// ever overwrites the cache. A locally edited cache file cannot survive
  /// this: [confirmWithHub]-style trust never applies to the local copy,
  /// only to what the Hub itself just signed and returned.
  Future<RevalidationOutcome> revalidateAgainstHub({
    required Future<SignedPanelConfig> Function() fetchAuthoritativeConfig,
    required HubConfigVerifier verifier,
  }) async {
    final cached = await store.load();
    if (cached == null) {
      // Nothing to revalidate — a fresh panel goes through first-boot
      // provisioning instead, not this path.
      return const RevalidationOutcome(
          ConfigVerificationResult.rejectedInvalidSignature, null);
    }

    final incoming = await fetchAuthoritativeConfig();
    final result = verifier.verify(
      incoming: incoming,
      currentConfigurationVersion: cached.assignment?.configurationVersion,
    );

    if (result != ConfigVerificationResult.verified) {
      // Reject and keep the existing (already-trusted) cache — never adopt
      // an unverified or stale-version config, and never lose the last
      // known-good state over a rejection.
      return RevalidationOutcome(result, cached);
    }

    final next = PanelConfig(
      identity: cached.identity,
      provisioningState: incoming.provisioningState,
      assignment: incoming.assignment,
    );
    await store.save(next);
    return RevalidationOutcome(result, next);
  }
}

class RevalidationOutcome {
  final ConfigVerificationResult result;
  final PanelConfig? config;
  const RevalidationOutcome(this.result, this.config);
}

class AreaSummary {
  final String id;
  final String name;
  final String? floorId;
  const AreaSummary({required this.id, required this.name, this.floorId});
}
