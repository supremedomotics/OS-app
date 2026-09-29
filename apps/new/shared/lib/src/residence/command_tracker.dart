/// The command lifecycle — requested → pending → confirmed | failed (§31).
///
/// * **requested** — the homeowner asked; nothing has left the device yet.
/// * **pending** — the Hub accepted the command. Still not a physical fact.
/// * **confirmed** — ONLY when an authoritative device report (a `/v1/stream` state delta) shows
///   a state that satisfies the command's expectation (`expectationOf`). The Hub's own
///   `CommandResponse.device` echo is deliberately NOT a confirmation: the contract says
///   optimistic clients "reconcile via WSS".
/// * **failed** — the Hub rejected it, could not be reached, the device is offline, or no
///   satisfying report arrived before the timeout. The Residence State is left untouched, so the
///   control simply returns to the last-known real value.
///
/// The one non-report confirmation: when the Hub accepts a command whose target the device is
/// ALREADY reporting (turning on a light that is on), no report will ever follow; that is
/// confirmed from the current authoritative state and recorded as `alreadyInState`.
///
/// This class holds transient lifecycle records only. It never edits [ResidenceState].
library;

import 'dart:async';

import 'residence_state.dart';
import 'state_expectation.dart';

enum CommandPhase { requested, pending, confirmed, failed }

enum CommandFailure {
  rejected,
  unreachable,
  deviceOffline,
  timeout,
  superseded
}

enum ConfirmedBy { deviceReport, alreadyInState }

class CommandRecord {
  final int id;
  final String deviceId;
  final String capability;
  final Map<String, dynamic> command;
  final CommandPhase phase;
  final DateTime requestedAt;
  final DateTime? resolvedAt;
  final CommandFailure? failure;
  final ConfirmedBy? confirmedBy;

  const CommandRecord({
    required this.id,
    required this.deviceId,
    required this.capability,
    required this.command,
    required this.phase,
    required this.requestedAt,
    this.resolvedAt,
    this.failure,
    this.confirmedBy,
  });

  bool get inFlight =>
      phase == CommandPhase.requested || phase == CommandPhase.pending;

  CommandRecord _to(CommandPhase p,
          {DateTime? at, CommandFailure? failure, ConfirmedBy? by}) =>
      CommandRecord(
        id: id,
        deviceId: deviceId,
        capability: capability,
        command: command,
        phase: p,
        requestedAt: requestedAt,
        resolvedAt: at ?? resolvedAt,
        failure: failure,
        confirmedBy: by,
      );
}

typedef CommandSender = Future<Map<String, dynamic>> Function(
    String deviceId, Map<String, dynamic> command);

typedef Schedule = Timer Function(Duration after, void Function() run);

class CommandTracker {
  final CommandSender _send;
  final ResidenceState _state;
  final Duration timeout;
  final Schedule _schedule;
  final DateTime Function() _now;

  final _updates = StreamController<CommandRecord>.broadcast();
  final _records = <int, CommandRecord>{};
  final _expect = <int, StateExpectation>{};
  final _timers = <int, Timer>{};
  final _facet = <int, String>{};
  StreamSubscription<DeviceReport>? _reportSub;
  int _next = 1;

  CommandTracker({
    required CommandSender send,
    required ResidenceState state,
    this.timeout = const Duration(seconds: 8),
    Schedule? schedule,
    DateTime Function()? now,
  })  : _send = send,
        _state = state,
        _schedule = schedule ?? ((d, f) => Timer(d, f)),
        _now = now ?? DateTime.now {
    _reportSub = state.reports.listen(_onReport);
  }

  bool _disposed = false;

  void _emit(CommandRecord r) {
    if (!_disposed) _updates.add(r);
  }

  Stream<CommandRecord> get updates => _updates.stream;

  /// Commands still requested or pending.
  List<CommandRecord> get inFlight => [
        for (final r in _records.values)
          if (r.inFlight) r
      ];

  /// The most recent record for this control — what its UI should reflect.
  CommandRecord? latestFor(String deviceId, String capability) {
    CommandRecord? best;
    for (final r in _records.values) {
      if (r.deviceId == deviceId &&
          r.capability == capability &&
          r.failure != CommandFailure.superseded &&
          (best == null || r.id > best.id)) {
        best = r;
      }
    }
    return best;
  }

  /// Returns the record immediately (phase `requested`); progress arrives on [updates].
  /// Throws [ArgumentError] for a command whose effect cannot be verified from device state —
  /// the UI must not offer such a control as confirmable.
  CommandRecord submit(String deviceId, Map<String, dynamic> command) {
    final capability = command['capability'] as String?;
    final expectation =
        capability == null ? null : expectationOf(capability, command);
    if (capability == null || expectation == null) {
      throw ArgumentError('command has no verifiable effect: $command');
    }
    // A newer command for the same control replaces the older one (a dragged slider). A control
    // is a facet of a capability: volume and playback are different controls on one speaker.
    final facet = _facetOf(capability, command);
    for (final r in _records.values.toList()) {
      if (r.inFlight &&
          r.deviceId == deviceId &&
          r.capability == capability &&
          _facet[r.id] == facet) {
        _settle(r, CommandPhase.failed, failure: CommandFailure.superseded);
      }
    }
    _records.removeWhere((_, r) =>
        !r.inFlight && r.deviceId == deviceId && r.capability == capability);
    _expect.removeWhere((id, _) => !_records.containsKey(id));
    _facet.removeWhere((id, _) => !_records.containsKey(id));
    final rec = CommandRecord(
      id: _next++,
      deviceId: deviceId,
      capability: capability,
      command: command,
      phase: CommandPhase.requested,
      requestedAt: _now(),
    );
    _records[rec.id] = rec;
    _expect[rec.id] = expectation;
    _facet[rec.id] = facet;
    _emit(rec);
    _timers[rec.id] = _schedule(timeout, () => _onTimeout(rec.id));
    unawaited(_dispatch(rec.id, _send));
    return rec;
  }

  static String _facetOf(String capability, Map<String, dynamic> c) {
    switch (capability) {
      case 'media':
        return switch (c['action']) {
          'volume' => 'volume',
          'mute' || 'unmute' => 'mute',
          _ => 'playback',
        };
      case 'temperature':
        return c['targetC'] != null ? 'target' : 'mode';
      default:
        return capability;
    }
  }

  Future<void> _dispatch(int id, CommandSender send) async {
    final rec = _records[id]!;
    final device = _state.snapshot.devices[rec.deviceId];
    if (device != null && !device.isOnline) {
      _settle(rec, CommandPhase.failed, failure: CommandFailure.deviceOffline);
      return;
    }
    Map<String, dynamic> res;
    try {
      res = await send(rec.deviceId, rec.command);
    } catch (_) {
      _settleId(id, CommandPhase.failed, failure: CommandFailure.unreachable);
      return;
    }
    final current = _records[id];
    if (current == null || !current.inFlight) return;
    if (res['accepted'] == false) {
      _settleId(id, CommandPhase.failed, failure: CommandFailure.rejected);
      return;
    }
    // A report may already have confirmed it while the ack was in flight.
    _records[id] = current._to(CommandPhase.pending);
    _emit(_records[id]!);

    final now = _state.snapshot.devices[rec.deviceId]?.state[rec.capability];
    if (now != null && _expect[id]!.matches(now)) {
      _settleId(id, CommandPhase.confirmed, by: ConfirmedBy.alreadyInState);
    }
  }

  void _onReport(DeviceReport r) {
    for (final rec in _records.values.toList()) {
      if (!rec.inFlight ||
          rec.deviceId != r.deviceId ||
          rec.capability != r.capability) {
        continue;
      }
      if (_expect[rec.id]!.matches(r.state)) {
        _settle(rec, CommandPhase.confirmed, by: ConfirmedBy.deviceReport);
      } else if (r.state['moving'] == true) {
        // The device is visibly on its way (a shade in travel): it is answering, so the deadline
        // restarts from this report instead of failing a slow but genuine movement.
        _timers.remove(rec.id)?.cancel();
        _timers[rec.id] = _schedule(timeout, () => _onTimeout(rec.id));
      }
    }
  }

  void _onTimeout(int id) {
    final rec = _records[id];
    if (rec != null && rec.inFlight) {
      _settle(rec, CommandPhase.failed, failure: CommandFailure.timeout);
    }
  }

  void _settleId(int id, CommandPhase p,
      {CommandFailure? failure, ConfirmedBy? by}) {
    final rec = _records[id];
    if (rec != null && rec.inFlight) _settle(rec, p, failure: failure, by: by);
  }

  void _settle(CommandRecord rec, CommandPhase p,
      {CommandFailure? failure, ConfirmedBy? by}) {
    _timers.remove(rec.id)?.cancel();
    final done = rec._to(p, at: _now(), failure: failure, by: by);
    _records[rec.id] = done;
    _emit(done);
  }

  Future<void> dispose() async {
    _disposed = true;
    for (final t in _timers.values) {
      t.cancel();
    }
    await _reportSub?.cancel();
    await _updates.close();
  }
}
