/// The one place a live Hub stream is joined to the Residence State (Mobile, Touch Panel and the
/// live-gateway test all use it — no client re-implements this wiring).
///
/// * The stream's frames feed [ResidenceState].
/// * Every time the stream reports `subscribed` — the first included — the state is re-read. A
///   snapshot taken before the subscription went live can miss a change made in between, and a
///   reconnect restarts per-device sequence numbers and drops whatever changed while it was down;
///   only a snapshot read AFTER the subscription recovers both.
/// * [followConnection]: the state follows the Hub CONNECTION too. It is re-read each time the
///   connection becomes usable (the first read runs while it is still authenticating and cannot
///   succeed, and the stream's `subscribed` can arrive before the connection is usable, so neither
///   is a safe trigger alone), and it is marked unreachable when the connection fails outright.
///
/// `subscribed` only means "the Hub will now send me changes" when the stream was built with
/// `autoSubscribeRooms` (it then waits for the Hub's `pong` to its subscription).
library;

import 'dart:async';

import '../connection/connection_manager.dart';
import '../runtime/event_stream_transport.dart';
import 'residence_state.dart';

class ResidenceStreamLink {
  final ResidenceState state;
  final StreamController<Map<String, dynamic>> _feed;

  EventStreamTransport? _stream;
  StreamSubscription<Map<String, dynamic>>? _frameSub;
  StreamSubscription<HubEventStreamState>? _stateSub;
  StreamSubscription<HubConnectionState>? _connSub;

  ResidenceStreamLink._(this.state, this._feed);

  /// The state is built on the link's own frame feed so a stream can be attached later, once the
  /// Hub's address is known.
  factory ResidenceStreamLink({required ResidenceGet get, DateTime Function()? now}) {
    final feed = StreamController<Map<String, dynamic>>.broadcast();
    return ResidenceStreamLink._(ResidenceState(get: get, frames: feed.stream, now: now), feed);
  }

  /// Joins [stream] to the state and connects it. Call once.
  void attach(EventStreamTransport stream) {
    assert(_stream == null, 'a link carries one stream');
    _stream = stream;
    _frameSub = stream.frames.listen(_feed.add);
    _stateSub = stream.state.listen((s) {
      if (s == HubEventStreamState.subscribed) unawaited(state.streamRestarted());
    });
    unawaited(stream.connect());
  }

  /// Follows the Hub connection: re-reads the residence on every transition to connected (not on
  /// each event while it stays connected), and marks it unreachable when the connection fails
  /// outright — offline (no Hub found), reconnecting, or credentials refused. Discovering,
  /// connecting and authenticating are not failures: the residence stays Loading through them.
  /// [initial] is the connection's state now: an already-connected link is not re-read for it, and
  /// one attached after the connection already failed is unreachable straight away (a broadcast
  /// stream does not replay what it emitted before this link listened).
  /// Call once, before the connection can change.
  void followConnection(Stream<HubConnectionState> states, {required HubConnectionState initial}) {
    assert(_connSub == null, 'a link watches one connection');
    var was = initial.isConnected;
    if (!was && _failed(initial.status)) state.markUnreachable();
    _connSub = states.listen((s) {
      final now = s.isConnected;
      if (now && !was) unawaited(state.refresh());
      if (!now && _failed(s.status)) state.markUnreachable();
      was = now;
    });
  }

  static bool _failed(ConnectionStatus status) =>
      status == ConnectionStatus.offline ||
      status == ConnectionStatus.reconnecting ||
      status == ConnectionStatus.authenticationFailed;

  Future<void> dispose() async {
    await _connSub?.cancel();
    await _stateSub?.cancel();
    await _frameSub?.cancel();
    await _stream?.dispose();
    await _feed.close();
    await state.dispose();
  }
}
