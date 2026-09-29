import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// The panel's one read model of the residence (ADR 0102): the same `ResidenceState`, command
/// lifecycle and Hub-orchestrated Experience activation the Mobile app uses. The panel holds no
/// device state of its own and never talks a protocol — every control below is derived from the
/// Hub's records and reports.
///
/// The transport is injected: a commissioned panel supplies its Hub session (panel commissioning
/// is not built yet); development and tests supply a `SimulatedResidence`, explicitly.
class PanelResidence {
  final ResidenceState state;
  final CommandTracker tracker;
  final ExperienceActivations activations;
  final Future<void> Function()? _onDispose;

  final _changes = StreamController<void>.broadcast();
  final _subs = <StreamSubscription<Object?>>[];

  PanelResidence._(this.state, this.tracker, this.activations, this._onDispose) {
    void ping(Object? _) {
      if (!_changes.isClosed) _changes.add(null);
    }

    _subs
      ..add(state.changes.listen(ping))
      ..add(state.runUpdates.listen(ping))
      ..add(tracker.updates.listen(ping))
      ..add(activations.updates.listen(ping));
  }

  factory PanelResidence.fromHub({
    required ResidenceGet get,
    required HubPost post,
    required Stream<Map<String, dynamic>> frames,
    Schedule? schedule,
    DateTime Function()? now,
    Future<void> Function()? onDispose,
  }) {
    final state = ResidenceState(get: get, frames: frames, now: now);
    final tracker = CommandTracker(
      send: (id, c) => post('v1/devices/$id/command', {'command': c}),
      state: state,
      schedule: schedule,
      now: now,
    );
    final acts = ExperienceActivations(post: post, state: state, now: now);
    return PanelResidence._(state, tracker, acts, onDispose);
  }

  /// Development / QA only, and only when asked for explicitly.
  factory PanelResidence.simulated(SimulatedResidence sim,
      {Schedule? schedule, DateTime Function()? now}) {
    final r = PanelResidence.fromHub(
      get: sim.transport.get,
      post: sim.transport.sendCommand,
      frames: sim.stream.frames,
      schedule: schedule,
      now: now,
    );
    unawaited(sim.transport.authenticate().then((_) => r.state.start()));
    return r;
  }

  Stream<void> get changes => _changes.stream;
  ResidenceSnapshot get snapshot => state.snapshot;

  /// The Hub answered and its records are current (or last-known while it is unreachable — the
  /// panel then says so and disables commands rather than showing stale controls as live).
  bool get connected => snapshot.loaded && snapshot.reachable == true;

  /// The Hub's own rooms as provisioning areas — never a hardcoded list.
  Future<List<AreaSummary>> areas() async {
    if (!snapshot.loaded) {
      await state.changes.firstWhere((_) => snapshot.loaded).timeout(
            const Duration(seconds: 10),
            onTimeout: () => snapshot,
          );
    }
    return [
      for (final s in snapshot.spaces)
        AreaSummary(id: s.id, name: s.name, floorId: s.floorId)
    ];
  }

  void run(List<DeviceCommand> commands) {
    for (final c in commands) {
      tracker.submit(c.deviceId, c.command);
    }
  }

  Future<void> dispose() async {
    for (final s in _subs) {
      await s.cancel();
    }
    await activations.dispose();
    await tracker.dispose();
    await state.dispose();
    await _changes.close();
    await _onDispose?.call();
  }
}

class PanelResidenceScope extends InheritedWidget {
  final PanelResidence? residence;
  const PanelResidenceScope(
      {super.key, required this.residence, required super.child});

  static PanelResidence? maybeOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<PanelResidenceScope>()
      ?.residence;

  @override
  bool updateShouldNotify(PanelResidenceScope old) => old.residence != residence;
}

/// Rebuilds whenever the residence, a command or an activation changes.
class PanelResidenceBuilder extends StatefulWidget {
  final Widget Function(BuildContext, PanelResidence?) builder;
  const PanelResidenceBuilder({super.key, required this.builder});

  @override
  State<PanelResidenceBuilder> createState() => _PanelResidenceBuilderState();
}

class _PanelResidenceBuilderState extends State<PanelResidenceBuilder> {
  PanelResidence? _bound;
  StreamSubscription<void>? _sub;

  void _bind(PanelResidence? r) {
    if (identical(r, _bound)) return;
    _sub?.cancel();
    _bound = r;
    _sub = r?.changes.listen((_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _bind(PanelResidenceScope.maybeOf(context));
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, _bound);
}
