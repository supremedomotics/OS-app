import 'panel_registry.dart';

/// Derives a panel's [PanelConnectionState] and `lastSeen` from heartbeat
/// timestamps with a grace period (§Phase9-18) — this is the client-side
/// half of the contract; the Hub is the actual source of truth for what
/// other clients see in the Touch Panel registry (§17). Deliberately does
/// NOT declare a panel disconnected on a single missed beat: only once
/// [gracePeriod] has elapsed since the last one.
///
/// HONEST STATUS: this is a real, pure state-derivation model
/// (deterministic, fully testable — no wall-clock flakiness since callers
/// pass in a `now`). It does not, by itself, implement the actual
/// heartbeat wire protocol (§17 registry persistence remains explicitly a
/// Hub-side implementation this phase documents rather than fakes on the
/// client — see the report).
class PanelHeartbeatMonitor {
  final Duration gracePeriod;
  DateTime? _lastSeen;

  PanelHeartbeatMonitor({this.gracePeriod = const Duration(seconds: 30)});

  DateTime? get lastSeen => _lastSeen;

  void recordHeartbeat(DateTime at) {
    if (_lastSeen == null || at.isAfter(_lastSeen!)) {
      _lastSeen = at;
    }
  }

  /// [now] is passed explicitly rather than read from the wall clock so
  /// this stays deterministic under test (§Phase9-19).
  PanelConnectionState connectionStateAt(DateTime now) {
    final last = _lastSeen;
    if (last == null) return PanelConnectionState.disconnected;
    return now.difference(last) <= gracePeriod
        ? PanelConnectionState.connected
        : PanelConnectionState.disconnected;
  }
}
