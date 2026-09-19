import 'dart:async';
import 'transport.dart';

/// The only connection states the UI is allowed to know about (§14, §31,
/// §32, §Phase9-15). Every screen renders from this enum plus [lastError] —
/// never from transport internals. Deliberately the smallest useful model:
/// `authenticating` is shared by both LAN and remote paths (the UI never
/// needs to distinguish transport kind, §Phase9-14), sitting between a
/// transport-level `connect()` succeeding and a session actually being
/// authorized — so "connected" never means anything less than "actually
/// authenticated" (§ authentication boundary).
enum ConnectionStatus {
  offline,
  discoveringLan,
  connectingLocal,
  connectingRemote,
  authenticating,
  connectedLocal,
  connectedRemote,
  reconnecting,
  authenticationFailed,
}

class HubConnectionState {
  final ConnectionStatus status;
  final String? lastError;
  const HubConnectionState(this.status, {this.lastError});

  bool get isConnected =>
      status == ConnectionStatus.connectedLocal ||
      status == ConnectionStatus.connectedRemote;
}

/// Centralizes discovery, connection, authentication, transport selection,
/// reconnect/backoff and event fan-out (§14, §32, §Phase9-7/8) so no
/// individual screen has to implement any of that. Mobile and Touch Panel
/// both consume this identically; only the transport/discovery
/// implementations differ per platform.
class ConnectionManager {
  final HubDiscovery discovery;
  final HubTransport Function(Uri lanUri) makeLanTransport;
  final HubTransport Function()? makeRemoteTransport;

  /// Remote access is opt-in and OFF by default (§14, §Phase9-12).
  bool remoteAccessEnabled;

  final _controller = StreamController<HubConnectionState>.broadcast();
  HubConnectionState _state =
      const HubConnectionState(ConnectionStatus.offline);
  HubTransport? _active;
  Timer? _retryTimer;
  int _backoffStep = 0;

  ConnectionManager({
    required this.discovery,
    required this.makeLanTransport,
    this.makeRemoteTransport,
    this.remoteAccessEnabled = false,
  });

  Stream<HubConnectionState> get state => _controller.stream;
  HubConnectionState get current => _state;

  Future<void> start() async {
    _emit(ConnectionStatus.discoveringLan);
    final lanUri = await discovery.discoverLan();

    if (lanUri != null) {
      await _connectVia(makeLanTransport(lanUri),
          ConnectionStatus.connectingLocal, ConnectionStatus.connectedLocal);
      return;
    }

    if (!remoteAccessEnabled || makeRemoteTransport == null) {
      _emit(ConnectionStatus.offline);
      return;
    }

    await _connectVia(makeRemoteTransport!(), ConnectionStatus.connectingRemote,
        ConnectionStatus.connectedRemote);
  }

  Future<void> _connectVia(HubTransport transport, ConnectionStatus connecting,
      ConnectionStatus connected) async {
    _emit(connecting);
    try {
      await transport.connect();
      _emit(ConnectionStatus.authenticating);
      await transport.authenticate();
      _active = transport;
      _backoffStep = 0;
      _emit(connected);
    } on AuthenticationException catch (e) {
      // An authentication rejection is never silently treated as "just
      // retry" — it is its own terminal state (§ authentication boundary),
      // distinct from a transient network failure.
      _emit(ConnectionStatus.authenticationFailed, error: e.toString());
    } catch (e) {
      _scheduleReconnect(e.toString());
    }
  }

  void _scheduleReconnect(String error) {
    _emit(ConnectionStatus.reconnecting, error: error);
    _backoffStep = (_backoffStep + 1).clamp(0, 5);
    final delay = Duration(seconds: 1 << _backoffStep); // 2s..32s
    _retryTimer?.cancel();
    _retryTimer = Timer(delay, start);
  }

  /// Call when the OS reports a network transition (Wi-Fi↔5G, Wi-Fi A↔B,
  /// Internet lost/regained — §Phase11-14). This package stays platform-
  /// neutral on purpose: it does not listen for connectivity changes itself.
  ///
  /// HONEST STATUS: the reconnect behavior this triggers (re-discover LAN,
  /// fall back to remote if enabled, re-authenticate) is REAL/IMPLEMENTED —
  /// it is exactly [start] again. What is PRODUCTION HARDENING REQUIRED is
  /// wiring an actual OS listener (e.g. `connectivity_plus` in
  /// `apps/new/mobile`) to call this; no such wiring exists in this repo
  /// yet, and none is faked here.
  void notifyNetworkChanged() {
    _retryTimer?.cancel();
    _backoffStep = 0;
    unawaited(start());
  }

  Future<Map<String, dynamic>> sendCommand(
      String path, Map<String, dynamic> body) {
    final t = _active;
    if (t == null || !t.isConnected) {
      throw StateError('No active Hub connection ($_state)');
    }
    return t.sendCommand(path, body);
  }

  /// §Phase12.8 — passthrough for [HubTransport.get], same "must be connected" guard as
  /// [sendCommand].
  Future<Map<String, dynamic>> get(String path) {
    final t = _active;
    if (t == null || !t.isConnected) {
      throw StateError('No active Hub connection ($_state)');
    }
    return t.get(path);
  }

  void _emit(ConnectionStatus status, {String? error}) {
    _state = HubConnectionState(status, lastError: error);
    _controller.add(_state);
  }

  Future<void> dispose() async {
    _retryTimer?.cancel();
    await _controller.close();
    await _active?.disconnect();
  }
}
