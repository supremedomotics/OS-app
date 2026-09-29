/// The simulated Hub's Experience run engine — a Dart port of `services/gateway/src/scene-runs.ts`
/// so the simulator conforms to the SAME contract as the real gateway (`SceneRun`, `run` frames).
/// Same semantics: phases in order, each starting only when the previous concluded from device
/// state; confirmation only from a device report (or current state) satisfying the shared
/// `expectationOf`; per-capability deadlines that a moving device restarts; supersession; an
/// unverifiable step ends at `sent`.
///
/// Drift between this port and the gateway is caught by `test/wire_conformance_test.dart`
/// (shape) and by the live-gateway lifecycle test (behaviour).
library;

import 'dart:async';

import '../residence/command_deadlines.dart';
import '../residence/command_tracker.dart' show Schedule;
import '../residence/state_expectation.dart';

const _defaultDeadlines = defaultCommandDeadlines;

class _Step {
  final String stepId;
  final String deviceId;
  final String? roomId;
  final String capability;
  final bool verifiable;
  final int index;
  final Map<String, dynamic>? command;
  String state;
  String? reason;
  void Function()? cancel;
  _Step(this.stepId, this.deviceId, this.roomId, this.capability, this.verifiable,
      this.index, this.command, this.state, this.reason);

  Map<String, dynamic> json() => {
        'stepId': stepId,
        'deviceId': deviceId,
        'roomId': roomId,
        'capability': capability,
        'state': state,
        'verifiable': verifiable,
        'reason': reason,
      };
}

class _Run {
  final String runId, sceneId;
  final List<String> spaceIds;
  final DateTime startedAt;
  final List<_Step> steps;
  final int phases;
  String status = 'running';
  DateTime? finishedAt;
  int phase = 0;
  String? supersededBy;
  _Run(this.runId, this.sceneId, this.spaceIds, this.startedAt, this.steps, this.phases);

  Map<String, dynamic> json() => {
        'runId': runId,
        'sceneId': sceneId,
        'spaceIds': spaceIds,
        'status': status,
        'startedAt': startedAt.toUtc().toIso8601String(),
        'finishedAt': finishedAt?.toUtc().toIso8601String(),
        'phase': phase,
        'phases': phases,
        'steps': [for (final s in steps) s.json()],
        'supersededBy': supersededBy,
      };
}

class SimulatedSceneRunner {
  final Schedule _schedule;
  final DateTime Function() _now;

  /// Sends a device command; the device reports on its own time. Throws when it cannot be sent.
  final void Function(String deviceId, Map<String, dynamic> command) sendCommand;
  final Map<String, dynamic>? Function(String deviceId) device;
  final void Function(Map<String, dynamic> runJson) publish;
  final Map<String, Duration> deadlines;

  final _runs = <String, _Run>{};
  final _waiting = <String, Set<void Function(Map<String, dynamic>)>>{};
  int _n = 0;

  SimulatedSceneRunner({
    required Schedule schedule,
    required DateTime Function() now,
    required this.sendCommand,
    required this.device,
    required this.publish,
    Map<String, Duration> deadlines = const {},
  })  : _schedule = schedule,
        _now = now,
        deadlines = {..._defaultDeadlines, ...deadlines};

  Map<String, dynamic>? get(String runId) => _runs[runId]?.json();

  /// The simulated device reported [state] for [capability].
  void onReport(String deviceId, String capability, Map<String, dynamic> state) {
    final set = _waiting['$deviceId:$capability'];
    if (set == null) return;
    for (final f in [...set]) {
      f(state);
    }
  }

  Map<String, dynamic> start(Map<String, dynamic> scene, List<String> spaceIds) {
    final steps = <_Step>[];
    final rawSteps = (scene['steps'] as List).cast<Map<String, dynamic>>();
    for (var i = 0; i < rawSteps.length; i++) {
      final st = rawSteps[i];
      final deviceId = st['deviceId'] as String;
      final d = device(deviceId);
      final roomId = d?['roomId'] as String?;
      if (spaceIds.isNotEmpty && (roomId == null || !spaceIds.contains(roomId))) continue;
      final cap = st['capability'] as String;
      final cmd = {'capability': cap, ...(st['values'] as Map).cast<String, dynamic>()};
      final verifiable = expectationOf(cap, cmd) != null;
      var state = 'queued';
      String? reason;
      if (d == null) {
        state = 'skipped';
        reason = 'device_not_found';
      } else if (d['status'] != 'online') {
        state = 'skipped';
        reason = 'device_unreachable';
      }
      steps.add(_Step('${scene['id']}:$i', deviceId, roomId, cap, verifiable, i,
          state == 'queued' ? cmd : null, state, reason));
    }

    final phased = <int>{};
    final groups = <List<_Step>>[];
    for (final ph in (scene['phases'] as List? ?? const [])) {
      final idx = [for (final i in ph as List) (i as num).toInt()];
      phased.addAll(idx);
      final g = [for (final s in steps) if (idx.contains(s.index)) s];
      if (g.isNotEmpty) groups.add(g);
    }
    final free = [for (final s in steps) if (!phased.contains(s.index)) s];

    final run = _Run('sim-run-${++_n}', scene['id'] as String, spaceIds, _now(), steps, groups.length);
    _supersede(run);
    _runs[run.runId] = run;
    while (_runs.length > 50) {
      _runs.remove(_runs.keys.first);
    }
    publish(run.json());
    final first = run.json();

    // Free steps start at once; phases one after another.
    for (final s in free) {
      _runStep(run, s, () => _maybeFinish(run, groups));
    }
    _advance(run, groups, 0);
    if (free.isEmpty && groups.isEmpty) _finish(run);
    return first;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  void _emit(_Run r) => publish(r.json());

  void _advance(_Run run, List<List<_Step>> groups, int i) {
    if (i >= groups.length) {
      _maybeFinish(run, groups);
      return;
    }
    run.phase = i + 1;
    _emit(run);
    final g = groups[i];
    var pending = g.length;
    void one() {
      pending--;
      if (pending == 0) _advance(run, groups, i + 1);
    }

    for (final s in g) {
      _runStep(run, s, one);
    }
  }

  void _maybeFinish(_Run run, List<List<_Step>> groups) {
    if (run.status != 'running') return;
    final open = run.steps.any((s) =>
        s.state == 'queued' || (s.state == 'sent' && s.verifiable));
    if (!open) _finish(run);
  }

  void _finish(_Run run) {
    if (run.status != 'running') return;
    final bad = run.steps.where((s) => const {'failed', 'timeout', 'skipped'}.contains(s.state)).length;
    final good = run.steps.where((s) => s.state == 'confirmed' || s.state == 'sent').length;
    run.status = bad == 0 ? 'completed' : good == 0 ? 'failed' : 'partial';
    run.finishedAt = _now();
    _emit(run);
  }

  void _set(_Run run, _Step s, String state, [String? reason]) {
    s.state = state;
    s.reason = reason;
    _emit(run);
  }

  void _runStep(_Run run, _Step s, void Function() done) {
    if (s.state != 'queued' || s.command == null) {
      done();
      return;
    }
    try {
      sendCommand(s.deviceId, s.command!);
    } catch (e) {
      _set(run, s, 'failed', e.toString().replaceFirst('Bad state: ', ''));
      done();
      return;
    }
    if (s.state != 'queued') {
      done();
      return;
    }
    _set(run, s, 'sent');
    final exp = expectationOf(s.capability, s.command!);
    if (exp == null) {
      done();
      _maybeFinish(run, const []);
      return;
    }
    final now = (device(s.deviceId)?['state'] as Map?)?[s.capability];
    if (now is Map && exp.matches(now.cast<String, dynamic>())) {
      _set(run, s, 'confirmed');
      done();
      _maybeFinish(run, const []);
      return;
    }

    final key = '${s.deviceId}:${s.capability}';
    final ms = deadlines[s.capability] ?? fallbackCommandDeadline;
    Timer? timer;
    late void Function(Map<String, dynamic>) listener;
    void conclude(String state, String? reason) {
      timer?.cancel();
      _waiting[key]?.remove(listener);
      s.cancel = null;
      if (s.state == 'sent') _set(run, s, state, reason);
      done();
      _maybeFinish(run, const []);
    }

    timer = _schedule(ms, () => conclude('timeout', 'no_report'));
    listener = (state) {
      if (exp.matches(state)) {
        conclude('confirmed', null);
      } else if (state['moving'] == true) {
        timer?.cancel();
        timer = _schedule(ms, () => conclude('timeout', 'no_report'));
      }
    };
    (_waiting[key] ??= {}).add(listener);
    s.cancel = () => conclude('skipped', 'superseded');
  }

  void _supersede(_Run next) {
    final mine = {
      for (final s in next.steps)
        if (s.state == 'queued') '${s.deviceId}:${s.capability}'
    };
    for (final live in _runs.values) {
      if (live.status != 'running') continue;
      var hit = false;
      for (final s in live.steps) {
        if ((s.state == 'queued' || s.state == 'sent') &&
            mine.contains('${s.deviceId}:${s.capability}')) {
          hit = true;
          if (s.cancel != null) {
            s.cancel!();
          } else if (s.state == 'queued') {
            s.state = 'skipped';
            s.reason = 'superseded';
          }
        }
      }
      if (hit) live.supersededBy = next.runId;
    }
  }
}
