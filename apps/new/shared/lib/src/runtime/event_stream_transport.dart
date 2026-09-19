import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

/// §Phase12.7 — the connection-state model for a live event-stream connection. Deliberately
/// distinct from `ConnectionStatus` (`connection_manager.dart`): `ConnectionManager` answers
/// "can I communicate with this Home at all" (command/read path); this answers "is the LIVE
/// EVENT CHANNEL connected" — related, never merged, since a Home can be perfectly reachable
/// for commands while its event stream is mid-reconnect, and the UI/runtime need to know which.
enum HubEventStreamState {
  disconnected,
  connecting,
  authenticating,
  subscribed,
  reconnecting,
  authFailed,
  closed,
  error,
}

/// The real Hub-side contract this abstracts over is the EXISTING `/v1/stream` WebSocket
/// (`services/gateway/src/stream.ts`) — no new protocol, no new endpoint (§Phase12.7 §1/§3).
/// One instance is scoped to exactly ONE canonical Home (`hubId`+`projectId`+its own
/// authorization) — never multiplexed across Homes (§5).
abstract class EventStreamTransport {
  Stream<HubEventStreamState> get state;

  /// Decoded raw server frames (`{type: "state"|"notification"|"driver"|"ack"|"pong"|"error",
  /// ...}`) — still protocol-shaped on purpose; `HomeEventMapper` is what turns these into
  /// `HomeEvent`s at the semantic boundary (§12), never this transport's job.
  Stream<Map<String, dynamic>> get frames;

  Future<void> connect();
  Future<void> disconnect();

  /// Sends a client frame (`{type: "subscribe", rooms: [...]}` etc.) — the same
  /// `ClientFrame` shape `stream.ts` already parses. Real commands still go through
  /// `HubTransport.sendCommand`/the REST routes (§Phase12.4); this exists only for stream-
  /// specific control frames (subscribe/unsubscribe/ping), not as a second command path.
  void send(Map<String, dynamic> frame);

  Future<void> dispose();
}

/// Real implementation against the ACTUAL `/v1/stream` route, using `package:web_socket_channel`
/// (a real, standard Dart package — no home-grown WebSocket parsing). Owns reconnect with
/// capped exponential backoff, and — critically (§4/§9) — does NOT retry forever on an
/// authorization failure: the server closes with WS code 1008 for every auth failure this
/// bridge produces (invalid/expired/revoked/wrong-Hub/wrong-project — Phase 12.4/12.6's
/// `resolveMobileOrSessionUser`), and this class treats 1008 as terminal (`authFailed`), never
/// retried with the same credential.
class WebSocketHubEventStream implements EventStreamTransport {
  final Uri streamUri;
  final String Function() bearerToken;

  /// Opens the real channel. Defaults to `WebSocketChannel.connect` (the real client); tests
  /// may point this at a real local `dart:io` WebSocket server instead of a live Hub — still a
  /// genuine socket connection, never a fake transport (§24: "do not call a mocked socket
  /// real").
  final WebSocketChannel Function(Uri uri) channelFactory;

  final _stateController = StreamController<HubEventStreamState>.broadcast();
  final _framesController = StreamController<Map<String, dynamic>>.broadcast();

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  int _backoffStep = 0;
  bool _disposed = false;
  HubEventStreamState _current = HubEventStreamState.disconnected;

  WebSocketHubEventStream({
    required this.streamUri,
    required this.bearerToken,
    WebSocketChannel Function(Uri uri)? channelFactory,
  }) : channelFactory = channelFactory ?? WebSocketChannel.connect;

  @override
  Stream<HubEventStreamState> get state => _stateController.stream;

  @override
  Stream<Map<String, dynamic>> get frames => _framesController.stream;

  void _emit(HubEventStreamState s) {
    _current = s;
    if (!_stateController.isClosed) _stateController.add(s);
  }

  @override
  Future<void> connect() async {
    if (_disposed) return;
    _emit(HubEventStreamState.connecting);
    final uri =
        streamUri.replace(queryParameters: {'access_token': bearerToken()});
    try {
      final channel = channelFactory(uri);
      _channel = channel;
      await channel.ready;
      _emit(HubEventStreamState.authenticating);
      _sub = channel.stream.listen(
        _onData,
        onDone: _onDone,
        onError: (_) => _scheduleReconnect(),
        cancelOnError: true,
      );
    } catch (_) {
      _scheduleReconnect();
    }
  }

  void _onData(dynamic raw) {
    Map<String, dynamic> frame;
    try {
      frame = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return; // malformed frame — dropped, never crashes the stream (§17/§Phase12.6 §14).
    }
    if (frame['type'] == 'error' && frame['code'] == 'unauthorized') {
      _emit(HubEventStreamState.authFailed);
      unawaited(_teardownSocket());
      return;
    }
    _backoffStep = 0;
    if (_current != HubEventStreamState.subscribed)
      _emit(HubEventStreamState.subscribed);
    if (!_framesController.isClosed) _framesController.add(frame);
  }

  void _onDone() {
    // The server closes with WS code 1008 for every authorization failure this bridge
    // produces (§Phase12.4/12.6) — treated as terminal, never retried with the same token.
    if (_channel?.closeCode == 1008) {
      _emit(HubEventStreamState.authFailed);
      return;
    }
    if (_disposed) {
      _emit(HubEventStreamState.closed);
      return;
    }
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_disposed || _current == HubEventStreamState.authFailed) return;
    _emit(HubEventStreamState.reconnecting);
    _backoffStep = (_backoffStep + 1).clamp(0, 5);
    Future.delayed(Duration(seconds: 1 << _backoffStep), () {
      if (!_disposed) connect();
    });
  }

  Future<void> _teardownSocket() async {
    await _sub?.cancel();
    _sub = null;
    try {
      await _channel?.sink.close();
    } catch (_) {}
  }

  @override
  Future<void> disconnect() async {
    await _teardownSocket();
    if (_current != HubEventStreamState.authFailed)
      _emit(HubEventStreamState.closed);
  }

  @override
  void send(Map<String, dynamic> frame) {
    try {
      _channel?.sink.add(jsonEncode(frame));
    } catch (_) {
      // A send failure on a dying socket is not this method's job to recover — `_onDone`/
      // `_onError` own reconnect.
    }
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    await _teardownSocket();
    await _stateController.close();
    await _framesController.close();
  }
}
