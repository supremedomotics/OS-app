import 'dart:async';

import 'event_stream_transport.dart';
import 'home_event_mapper.dart';
import 'mobile_runtime.dart';

/// §Phase12.7 — wires ONE Home's [EventStreamTransport] into [MobileRuntime], through
/// [HomeEventMapper], with snapshot recovery on (re)connect. This is the concrete answer to
/// "connect the real WebSocket to MobileRuntime" — one instance per authorized Home (§5), never
/// multiplexed, and independent of any widget/screen lifecycle (§2/§7: constructed and owned by
/// `RuntimeController`, never by a screen).
///
/// Recovery model, honestly per Phase 12.6's own finding: durable replay is NOT IMPLEMENTED (no
/// event-sequence persistence on the Hub) — so every `subscribed` transition (both the first
/// connect and every reconnect) triggers [onSnapshotRequired] before this session starts
/// forwarding live frames into [runtime], per §10's ordering requirement ("establish event
/// boundary → snapshot → reconcile → process subsequent events"). Frames that arrive from the
/// transport WHILE the snapshot is in flight are buffered, not dropped and not applied out of
/// order relative to the snapshot — they replay into `runtime` only after the snapshot
/// callback resolves, so a snapshot can never race a live event and lose it.
class HomeEventStreamSession {
  final String hubId;
  final String projectId;
  final EventStreamTransport transport;
  final MobileRuntime runtime;
  final HomeEventMapper mapper;

  /// Called every time the stream reaches `subscribed` (first connect AND every reconnect) —
  /// the caller re-fetches authoritative state (`HomeStateRepository`) and reconciles it. Never
  /// awaited by [dispose]/error paths beyond this session's own lifetime.
  final Future<void> Function() onSnapshotRequired;

  StreamSubscription<HubEventStreamState>? _stateSub;
  StreamSubscription<Map<String, dynamic>>? _frameSub;
  final List<Map<String, dynamic>> _pendingDuringSnapshot = [];
  bool _snapshotInFlight = false;
  bool _started = false;

  HomeEventStreamSession({
    required this.hubId,
    required this.projectId,
    required this.transport,
    required this.runtime,
    required this.onSnapshotRequired,
    this.mapper = const HomeEventMapper(),
  });

  /// Idempotent — calling `start()` twice never opens a second connection (§21/§22: "runtime
  /// starts again → no duplicate stream").
  Future<void> start() async {
    if (_started) return;
    _started = true;
    _stateSub = transport.state.listen(_onState);
    _frameSub = transport.frames.listen(_onFrame);
    await transport.connect();
  }

  void _onState(HubEventStreamState state) {
    if (state == HubEventStreamState.subscribed) {
      _runSnapshot();
    }
  }

  void _runSnapshot() {
    if (_snapshotInFlight) return;
    _snapshotInFlight = true;
    onSnapshotRequired().then((_) {
      _snapshotInFlight = false;
      final buffered = List<Map<String, dynamic>>.from(_pendingDuringSnapshot);
      _pendingDuringSnapshot.clear();
      for (final frame in buffered) {
        _forward(frame);
      }
    }).catchError((_) {
      // A failed snapshot leaves the stream connected (live events still matter — see
      // `_onFrame`) but never blocks recovery forever: the next reconnect tries again.
      _snapshotInFlight = false;
    });
  }

  void _onFrame(Map<String, dynamic> frame) {
    if (_snapshotInFlight) {
      _pendingDuringSnapshot.add(frame);
      return;
    }
    _forward(frame);
  }

  void _forward(Map<String, dynamic> frame) {
    final event = mapper.map(frame, hubId: hubId, projectId: projectId);
    if (event != null) runtime.ingestEvent(event);
  }

  Future<void> stop() async {
    await _stateSub?.cancel();
    await _frameSub?.cancel();
    _stateSub = null;
    _frameSub = null;
    _pendingDuringSnapshot.clear();
    _snapshotInFlight = false;
    _started = false;
    await transport.disconnect();
  }

  Future<void> dispose() async {
    await stop();
    await transport.dispose();
  }
}
