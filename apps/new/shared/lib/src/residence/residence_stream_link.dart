/// The one place a live Hub stream is joined to the Residence State (Mobile, Touch Panel and the
/// live-gateway test all use it — no client re-implements this wiring).
///
/// * The stream's frames feed [ResidenceState].
/// * Every time the stream reports `subscribed` — the first included — the state is re-read. A
///   snapshot taken before the subscription went live can miss a change made in between, and a
///   reconnect restarts per-device sequence numbers and drops whatever changed while it was down;
///   only a snapshot read AFTER the subscription recovers both.
///
/// `subscribed` only means "the Hub will now send me changes" when the stream was built with
/// `autoSubscribeRooms` (it then waits for the Hub's `pong` to its subscription).
library;

import 'dart:async';

import '../runtime/event_stream_transport.dart';
import 'residence_state.dart';

class ResidenceStreamLink {
  final ResidenceState state;
  final StreamController<Map<String, dynamic>> _feed;

  EventStreamTransport? _stream;
  StreamSubscription<Map<String, dynamic>>? _frameSub;
  StreamSubscription<HubEventStreamState>? _stateSub;

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

  Future<void> dispose() async {
    await _stateSub?.cancel();
    await _frameSub?.cancel();
    await _stream?.dispose();
    await _feed.close();
    await state.dispose();
  }
}
