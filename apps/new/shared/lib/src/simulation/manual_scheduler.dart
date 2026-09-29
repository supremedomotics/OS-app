import 'dart:async';

import '../residence/command_tracker.dart';

/// A deterministic clock + timer source. Tests (and the simulator, when told to) advance time
/// explicitly instead of sleeping, so latency, travel and timeouts are exercised exactly.
class ManualScheduler {
  DateTime _now = DateTime.utc(2026, 1, 1, 12);
  final _pending = <_ManualTimer>[];

  DateTime now() => _now;

  Schedule get schedule => (after, run) {
        final t = _ManualTimer(_now.add(after), run, _pending);
        _pending.add(t);
        return t;
      };

  /// Runs every timer due within [by], in time order, including ones scheduled meanwhile.
  Future<void> advance(Duration by) async {
    final until = _now.add(by);
    await Future<void>.delayed(Duration.zero);
    while (true) {
      _pending.removeWhere((t) => !t.isActive);
      final due = _pending.where((t) => !t.at.isAfter(until)).toList()
        ..sort((a, b) => a.at.compareTo(b.at));
      if (due.isEmpty) break;
      final t = due.first;
      _now = t.at;
      t.fire();
      // Let stream listeners and awaiting futures run before the next timer.
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
    }
    _now = until;
  }
}

class _ManualTimer implements Timer {
  final DateTime at;
  final void Function() _run;
  final List<_ManualTimer> _owner;
  bool _active = true;
  _ManualTimer(this.at, this._run, this._owner);

  void fire() {
    if (!_active) return;
    _active = false;
    _owner.remove(this);
    _run();
  }

  @override
  void cancel() {
    _active = false;
    _owner.remove(this);
  }

  @override
  bool get isActive => _active;

  @override
  int get tick => 0;
}
