/// The Hub's record of one Experience activation (`SceneRun` in
/// `packages/supreme-contracts/src/scene-runs.ts`) — a read model, pinned to the contract by
/// `test/residence_contract_parity_test.dart`.
///
/// A run EXPLAINS a transition (which step was sent, which did not answer). It is never the
/// answer to "is this Experience active": that is derived from device state.
library;

enum RunStepState { queued, sent, confirmed, failed, timeout, skipped }

enum RunStatus { running, completed, partial, failed }

class SceneRunStep {
  final String stepId;
  final String deviceId;
  final String? roomId;
  final String capability;
  final RunStepState state;

  /// Whether device state can prove this step took effect. An unverifiable step ends at `sent`.
  final bool verifiable;
  final String? reason;

  const SceneRunStep({
    required this.stepId,
    required this.deviceId,
    required this.roomId,
    required this.capability,
    required this.state,
    required this.verifiable,
    required this.reason,
  });

  bool get concluded => state != RunStepState.queued && !(state == RunStepState.sent && verifiable);

  /// The Hub could not, or did not manage to, do this step.
  bool get unmet =>
      state == RunStepState.failed ||
      state == RunStepState.timeout ||
      state == RunStepState.skipped;

  static SceneRunStep? fromJson(Map<String, dynamic> j) {
    final id = j['stepId'], dev = j['deviceId'], cap = j['capability'];
    if (id is! String || dev is! String || cap is! String) return null;
    return SceneRunStep(
      stepId: id,
      deviceId: dev,
      roomId: j['roomId'] as String?,
      capability: cap,
      state: RunStepState.values.asNameMap()[j['state']] ?? RunStepState.queued,
      verifiable: j['verifiable'] == true,
      reason: j['reason'] as String?,
    );
  }
}

class SceneRun {
  final String runId;
  final String sceneId;
  final List<String> spaceIds;
  final RunStatus status;
  final DateTime startedAt;
  final DateTime? finishedAt;
  final int phase;
  final int phases;
  final List<SceneRunStep> steps;
  final String? supersededBy;

  const SceneRun({
    required this.runId,
    required this.sceneId,
    required this.spaceIds,
    required this.status,
    required this.startedAt,
    required this.finishedAt,
    required this.phase,
    required this.phases,
    required this.steps,
    required this.supersededBy,
  });

  bool get isRunning => status == RunStatus.running;
  int get unmetCount => steps.where((s) => s.unmet).length;

  static SceneRun? fromJson(Map<String, dynamic> j) {
    final id = j['runId'], scene = j['sceneId'], started = j['startedAt'];
    if (id is! String || scene is! String || started is! String) return null;
    final at = DateTime.tryParse(started);
    if (at == null) return null;
    return SceneRun(
      runId: id,
      sceneId: scene,
      spaceIds: [...(j['spaceIds'] as List<dynamic>? ?? const []).cast<String>()],
      status: RunStatus.values.asNameMap()[j['status']] ?? RunStatus.running,
      startedAt: at,
      finishedAt: j['finishedAt'] is String ? DateTime.tryParse(j['finishedAt'] as String) : null,
      phase: (j['phase'] as num?)?.toInt() ?? 0,
      phases: (j['phases'] as num?)?.toInt() ?? 0,
      steps: [
        for (final s in (j['steps'] as List<dynamic>? ?? const []).whereType<Map<String, dynamic>>())
          if (SceneRunStep.fromJson(s) != null) SceneRunStep.fromJson(s)!
      ],
      supersededBy: j['supersededBy'] as String?,
    );
  }
}
