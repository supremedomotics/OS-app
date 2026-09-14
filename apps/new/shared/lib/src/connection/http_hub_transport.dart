import 'dart:convert';
import 'package:http/http.dart' as http;

import 'transport.dart';

/// §Phase12.8 — the real LAN `HubTransport`, closing the "LAN transport: MOCK/TEST ONLY" gap
/// every prior phase (9 through 12.7) carried forward. Talks directly to the Hub's own gateway
/// over HTTPS — the SAME real routes Phase 12.4 bridged for Mobile authorization
/// (`/v1/home`, `/v1/devices`, `/v1/rooms/:id/devices`, `/v1/devices/:id/command`,
/// `/v1/scenes`, `/v1/scenes/:id/activate`) — using the Mobile-authorization bearer token via
/// [bearerToken], exactly like [RemoteHubTransport] does through the broker, just without the
/// broker hop in between.
///
/// HONEST STATUS on the port: the real gateway REST/WS surface is served by the existing
/// internal gateway (proxied through Caddy on 443 per the established SupremeOS network
/// architecture) — NOT the native/local `:7272` client port, which has no HTTP listener for
/// this contract today (Phase 9's own finding, unchanged). [baseUrl] is therefore the Hub's
/// discovered LAN address on port 443 (matching `HttpPairingTransport`'s identical, already-
/// established choice for the same reason), not `SupremeOSHubDefaults.defaultPort`.
class HttpHubTransport implements HubTransport {
  final Uri baseUrl;
  final String Function() bearerToken;
  final http.Client _client;

  bool _authenticated = false;

  HttpHubTransport(
      {required this.baseUrl, required this.bearerToken, http.Client? client})
      : _client = client ?? http.Client();

  @override
  bool get isConnected => _authenticated;

  Map<String, String> get _authHeaders =>
      {'authorization': 'Bearer ${bearerToken()}'};

  Uri _routeUri(String path) =>
      baseUrl.resolve(path.startsWith('/') ? path.substring(1) : path);

  @override
  Future<void> connect() async {
    // Nothing to open ahead of time — same reasoning as `RemoteHubTransport`: this is a plain
    // HTTPS client, not a persistent socket this side holds open.
  }

  @override
  Future<void> authenticate() async {
    final res = await _client
        .get(_routeUri('v1/home'), headers: _authHeaders)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw const AuthenticationException(
          'Hub rejected this Mobile\'s credentials');
    }
    if (res.statusCode != 200) {
      throw StateError('unexpected Hub response: ${res.statusCode}');
    }
    _authenticated = true;
  }

  @override
  Future<void> disconnect() async {
    _authenticated = false;
  }

  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (!_authenticated) throw StateError('not authenticated');
    final res = await _client.get(_routeUri(path), headers: _authHeaders);
    if (res.statusCode >= 400) {
      throw StateError('read failed: ${res.statusCode} ${res.body}');
    }
    return res.body.isEmpty
        ? const {}
        : jsonDecode(res.body) as Map<String, dynamic>;
  }

  @override
  Future<Map<String, dynamic>> sendCommand(
      String path, Map<String, dynamic> body) async {
    if (!_authenticated) throw StateError('not authenticated');
    final res = await _client.post(
      _routeUri(path),
      headers: {..._authHeaders, 'content-type': 'application/json'},
      body: jsonEncode(body),
    );
    if (res.statusCode >= 400) {
      throw StateError('command failed: ${res.statusCode} ${res.body}');
    }
    return res.body.isEmpty
        ? const {}
        : jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// HONEST STATUS: live events for the LAN path are `/v1/stream` (a WebSocket,
  /// `WebSocketHubEventStream` — Phase 12.7), NOT this method — `HubTransport.events()` predates
  /// that real implementation and is left as an empty stream here rather than faked with
  /// polling. `HomeEventStreamSession` is the real event path; nothing in this codebase still
  /// reads from `HubTransport.events()` for the LAN case.
  @override
  Stream<Map<String, dynamic>> events() => const Stream.empty();
}
