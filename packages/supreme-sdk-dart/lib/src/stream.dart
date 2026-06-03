import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

/// A normalized device state delta received over the WSS stream.
class StateDelta {
  StateDelta({required this.deviceId, required this.roomId, required this.state, required this.seq});
  final String deviceId;
  final String? roomId;
  final Map<String, dynamic> state;
  final int seq;
}

/// Typed WSS client for `/v1/stream`. Subscribes to room scopes and surfaces
/// validated state deltas; optimistic UI updates are reconciled against these.
class SupremeStream {
  SupremeStream({required this.wsBaseUrl, required this.accessToken});

  final String wsBaseUrl;
  final String accessToken;

  WebSocketChannel? _channel;
  final _stateController = StreamController<StateDelta>.broadcast();

  Stream<StateDelta> get states => _stateController.stream;

  void connect() {
    final uri = Uri.parse('$wsBaseUrl/v1/stream?access_token=$accessToken');
    final channel = WebSocketChannel.connect(uri);
    _channel = channel;
    channel.stream.listen((raw) {
      final frame = jsonDecode(raw as String) as Map<String, dynamic>;
      if (frame['type'] == 'state') {
        _stateController.add(StateDelta(
          deviceId: frame['deviceId'] as String,
          roomId: frame['roomId'] as String?,
          state: frame['state'] as Map<String, dynamic>,
          seq: frame['seq'] as int,
        ));
      }
    }, onError: (_) {}, cancelOnError: false);
  }

  void subscribe(List<String> rooms) {
    _channel?.sink.add(jsonEncode({'type': 'subscribe', 'rooms': rooms}));
  }

  void command(String requestId, String deviceId, Map<String, dynamic> command) {
    _channel?.sink.add(jsonEncode({
      'type': 'command',
      'requestId': requestId,
      'deviceId': deviceId,
      'command': command,
    }));
  }

  Future<void> close() async {
    await _channel?.sink.close();
    await _stateController.close();
  }
}
