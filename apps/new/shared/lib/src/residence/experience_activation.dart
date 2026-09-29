/// Setting an Experience — the client's half of a Hub-orchestrated activation (ADR 0102, D8).
///
/// The Hub owns the orchestration: it resolves the steps, sequences the phases, sends the commands
/// and decides from device state when each step is confirmed. This class only (1) asks, (2) follows
/// the Hub's run, and (3) reports the same lifecycle every command has:
///
/// * **requested** — the homeowner asked; the request has not been accepted.
/// * **pending**  — the Hub accepted it and returned a run.
/// * **confirmed** — DERIVED: the devices' reported state satisfies the Experience (for the scope it
///   was set for). Never inferred from a response or from the run's status.
/// * **failed**   — the request was refused / unreachable, or the run ended and the devices still do
///   not satisfy the Experience.
///
/// It holds no orchestration logic and never sends a device command.
library;

import 'dart:async';

import '../experiences.dart';
import 'experience_status.dart';
import 'residence_state.dart';
import 'scene_run.dart';

enum ActivationPhase { requested, pending, confirmed, failed }

enum ActivationFailure { unreachable, rejected, incomplete }

class Activation {
  final int id;
  final String experienceId;

  /// Empty = the whole residence.
  final List<String> spaceIds;
  final ActivationPhase phase;
  final String? runId;
  final ActivationFailure? failure;
  final DateTime requestedAt;

  const Activation({
    required this.id,
    required this.experienceId,
    required this.spaceIds,
    required this.phase,
    required this.requestedAt,
    this.runId,
    this.failure,
  });

  bool get inFlight =>
      phase == ActivationPhase.requested || phase == ActivationPhase.pending;

  Activation _to(ActivationPhase p, {String? runId, ActivationFailure? failure}) => Activation(
        id: id,
        experienceId: experienceId,
        spaceIds: spaceIds,
        phase: p,
        requestedAt: requestedAt,
        runId: runId ?? this.runId,
        failure: failure,
      );
}

typedef HubPost = Future<Map<String, dynamic>> Function(String path, Map<String, dynamic> body);

class ExperienceActivations {
  final HubPost _post;
  final ResidenceState _state;
  final DateTime Function() _now;

  final _updates = StreamController<Activation>.broadcast();
  final _records = <int, Activation>{};
  StreamSubscription<ResidenceSnapshot>? _sub;
  StreamSubscription<SceneRun>? _runSub;
  bool _disposed = false;
  int _next = 1;

  ExperienceActivations({
    required HubPost post,
    required ResidenceState state,
    DateTime Function()? now,
  })  : _post = post,
        _state = state,
        _now = now ?? DateTime.now {
    _sub = state.changes.listen((_) => _reconcile());
    _runSub = state.runUpdates.listen((_) => _reconcile());
  }

  Stream<Activation> get updates => _updates.stream;
  List<Activation> get inFlight => [for (final a in _records.values) if (a.inFlight) a];

  Activation? latestFor(String experienceId, {List<String> spaceIds = const []}) {
    Activation? best;
    for (final a in _records.values) {
      if (a.experienceId == experienceId && _sameScope(a.spaceIds, spaceIds) && (best == null || a.id > best.id)) {
        best = a;
      }
    }
    return best;
  }

  /// Asks the Hub to set [e] for [spaceIds] (empty = the whole residence). Returns at once.
  Activation activate(Experience e, {List<String> spaceIds = const []}) {
    final rec = Activation(
      id: _next++,
      experienceId: e.id,
      spaceIds: spaceIds,
      phase: ActivationPhase.requested,
      requestedAt: _now(),
    );
    _records[rec.id] = rec;
    _emit(rec);
    unawaited(_send(rec.id, e));
    return rec;
  }

  Future<void> _send(int id, Experience e) async {
    final rec = _records[id]!;
    Map<String, dynamic> res;
    try {
      res = await _post('v1/scenes/${e.id}/activate',
          {if (rec.spaceIds.isNotEmpty) 'spaceIds': rec.spaceIds});
    } catch (_) {
      _settle(id, ActivationPhase.failed, failure: ActivationFailure.unreachable);
      return;
    }
    if (_disposed) return;
    final run = res['run'];
    if (res['activated'] == false || run is! Map<String, dynamic>) {
      _settle(id, ActivationPhase.failed, failure: ActivationFailure.rejected);
      return;
    }
    final runId = run['runId'] as String?;
    _state.noteRun(run);
    final cur = _records[id];
    if (cur == null || !cur.inFlight) return;
    _records[id] = cur._to(ActivationPhase.pending, runId: runId);
    _emit(_records[id]!);
    _reconcile();
  }

  /// Confirmation is derived, every time anything changes.
  void _reconcile() {
    if (_disposed) return;
    final snap = _state.snapshot;
    for (final a in _records.values.toList()) {
      if (a.phase != ActivationPhase.pending) continue;
      final e = snap.experiences.where((x) => x.id == a.experienceId).firstOrNull;
      if (e == null) continue;
      final scope = a.spaceIds.length == 1 ? a.spaceIds.first : null;
      final st = experienceStatus(e, snap, spaceId: scope);
      if (st.phase == ExperiencePhase.active) {
        _settle(a.id, ActivationPhase.confirmed);
        continue;
      }
      final run = a.runId == null ? null : snap.runs[a.runId];
      if (run != null && !run.isRunning && run.status != RunStatus.completed) {
        // A completed run means the Hub saw every step confirmed; the state frame that shows it is
        // (or is about to be) in the snapshot, so it is never called incomplete.
        
        _settle(a.id, ActivationPhase.failed, failure: ActivationFailure.incomplete);
      }
    }
  }

  void _settle(int id, ActivationPhase p, {ActivationFailure? failure}) {
    final cur = _records[id];
    if (cur == null || !cur.inFlight) return;
    _records[id] = cur._to(p, failure: failure);
    _emit(_records[id]!);
  }

  void _emit(Activation a) {
    if (!_disposed) _updates.add(a);
  }

  static bool _sameScope(List<String> a, List<String> b) =>
      a.length == b.length && a.every(b.contains);

  Future<void> dispose() async {
    _disposed = true;
    await _sub?.cancel();
    await _runSub?.cancel();
    await _updates.close();
  }
}
