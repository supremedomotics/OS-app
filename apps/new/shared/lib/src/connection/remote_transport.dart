import 'dart:convert';
import 'package:http/http.dart' as http;

import 'transport.dart';

/// Real remote transport (§Phase10-6..9) built against the SupremeOS Hub's
/// EXISTING, already-shipped production remote architecture — this phase
/// does NOT invent a new relay/NAT-traversal mechanism. Inspection found:
///
/// - `docs/architecture/adr/0009-zero-trust-tunnel-broker.md` — the Hub
///   dials OUT to a cloud Tunnel Broker over a persistent connection (no
///   inbound port, no port forwarding, no static IP — satisfies every
///   CGNAT/NAT requirement in §Phase10-7 structurally, by the existing
///   design, not by anything added here).
/// - `cloud/tunnel-broker/src/server.ts` — the broker exposes
///   `ALL /v1/route/:hubId/*`: a plain authenticated HTTPS request/response
///   proxy. A client sends a normal HTTP request with a bearer token; the
///   broker forwards it over the hub's tunnel to the hub's own local
///   gateway and returns the response. The broker never sees plaintext
///   application semantics beyond routing — it is "a transport, not a
///   man-in-the-middle" (the ADR's own words), which is exactly §Phase10-9's
///   requirement.
/// - There is deliberately no "direct remote" path distinct from the relay:
///   the ADR chose broker-only remote access for security (no inbound Hub
///   port, ever) — attempting a separate direct-connection/NAT-traversal
///   layer would contradict that existing decision, not complete it. Remote
///   in this architecture IS the broker path; `ConnectionStatus.connectedRemote`
///   means "via the Tunnel Broker," full stop.
///
/// HONEST STATUS (§Phase10-21/29): this class makes REAL HTTP calls against
/// the real broker's real route contract — it is not a mock. What is
/// genuinely missing for production use:
///   1. SERVER-SIDE REQUIRED — `cloud/tunnel-broker/src/main.ts` wires
///      `authorizeClient` to `devAllowAll` in dev mode only; a real verifier
///      (checking a Supreme access token + hub membership) does not exist
///      yet. Until it does, no bearer token this class sends is actually
///      checked by a production broker.
///   2. PRODUCTION HARDENING REQUIRED — there is no Mobile-side account
///      login/pairing flow yet that could produce a real bearer token or
///      learn a Hub's `hubId`/broker URL; both are constructor parameters
///      here, supplied by a future pairing flow, not fabricated.
///   3. §Phase12.9 UPDATE: real-time remote events are now carried over this SAME broker, via
///      `GET /v1/route/:hubId/stream` (a WebSocket, multiplexed over the hub's existing tunnel
///      socket — see `cloud/tunnel-broker/src/broker.ts`'s `openStream`, proven end-to-end
///      against a real broker + real hub gateway + real tunnel-client in
///      `services/gateway/src/broker-tunnel.e2e.test.ts`). [RemoteHubConfig.streamUri] builds
///      that URL; `WebSocketHubEventStream` (§Phase12.7) connects to it UNMODIFIED — the broker
///      route accepts the same `?access_token=` convention the Hub's own `/v1/stream` uses, so
///      there is no second stream-transport implementation for "remote." `events()` below is
///      UNCHANGED (still polling) — it belongs to `HubTransport`, a distinct, older interface
///      nothing in this codebase still reads from for live state (see `HttpHubTransport`'s
///      identical note); the real remote live path is the stream URI, not this method.
class RemoteHubConfig {
  final Uri brokerUrl;
  final String hubId;

  /// Supplied by a future account/pairing flow — never fabricated here.
  final String Function() bearerToken;

  const RemoteHubConfig(
      {required this.brokerUrl,
      required this.hubId,
      required this.bearerToken});

  Uri routeUri(String path) => brokerUrl.resolve('/v1/route/$hubId/$path');

  /// §Phase12.9 — the remote counterpart of a Home's LAN `wss://.../v1/stream` URI:
  /// `wss://<broker>/v1/route/<hubId>/stream`. Pass this straight to
  /// `WebSocketHubEventStream(streamUri: ...)` — that class appends `?access_token=` itself,
  /// exactly as it does for the LAN case, and the broker route validates it identically to the
  /// Hub's own `/v1/stream` (same Mobile-authorization token, same fail-closed checks).
  Uri streamUri() {
    final http = routeUri('stream');
    return http.replace(scheme: http.scheme == 'https' ? 'wss' : 'ws');
  }
}

class RemoteHubTransport implements HubTransport {
  final RemoteHubConfig config;
  final http.Client _client;
  final Duration pollInterval;

  bool _authenticated = false;

  RemoteHubTransport({
    required this.config,
    http.Client? client,
    this.pollInterval = const Duration(seconds: 5),
  }) : _client = client ?? http.Client();

  @override
  bool get isConnected => _authenticated;

  Map<String, String> get _authHeaders =>
      {'Authorization': 'Bearer ${config.bearerToken()}'};

  @override
  Future<void> connect() async {
    // Nothing to "open" ahead of time — this is a stateless HTTPS proxy
    // route, not a persistent socket the client holds (the HUB holds the
    // persistent connection to the broker; the client just calls an HTTPS
    // endpoint). Reachability + authorization are both verified in
    // [authenticate] via a real request, not assumed here.
  }

  @override
  Future<void> authenticate() async {
    final res = await _client
        .get(config.routeUri('healthz'), headers: _authHeaders)
        .timeout(const Duration(seconds: 10));

    if (res.statusCode == 403) {
      throw const AuthenticationException(
          'remote access denied — not authorized for this Hub');
    }
    if (res.statusCode == 503) {
      throw StateError('Hub is not reachable via the relay (hub_offline)');
    }
    if (res.statusCode != 200) {
      throw StateError('unexpected relay response: ${res.statusCode}');
    }
    _authenticated = true;
  }

  @override
  Future<void> disconnect() async {
    _authenticated = false;
  }

  @override
  Future<Map<String, dynamic>> sendCommand(
      String path, Map<String, dynamic> body) async {
    if (!_authenticated) throw StateError('not authenticated');
    final res = await _client.post(
      config.routeUri(path),
      headers: {..._authHeaders, 'content-type': 'application/json'},
      body: jsonEncode(body),
    );
    if (res.statusCode == 503) {
      throw StateError('Hub went offline mid-session (hub_offline)');
    }
    if (res.statusCode >= 400) {
      throw StateError('command failed: ${res.statusCode} ${res.body}');
    }
    return res.body.isEmpty
        ? const {}
        : jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// §Phase12.8 — the real Hub REST contract uses `GET` for reads
  /// (`/v1/home`, `/v1/devices`, `/v1/rooms/:id/devices`, `/v1/scenes`) — this is that verb,
  /// against the SAME broker route (`/v1/route/:hubId/*` forwards any HTTP verb).
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (!_authenticated) throw StateError('not authenticated');
    final res = await _client.get(config.routeUri(path), headers: _authHeaders);
    if (res.statusCode == 503) {
      throw StateError('Hub went offline mid-session (hub_offline)');
    }
    if (res.statusCode >= 400) {
      throw StateError('read failed: ${res.statusCode} ${res.body}');
    }
    return res.body.isEmpty
        ? const {}
        : jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Polling, not push (see class doc — the broker's client route is
  /// request/response only). Each tick is a real HTTPS GET; this is an
  /// honest, working fallback, not a fake live stream.
  @override
  Stream<Map<String, dynamic>> events() async* {
    while (_authenticated) {
      await Future.delayed(pollInterval);
      if (!_authenticated) break;
      try {
        final res = await _client.get(config.routeUri('v1/state'),
            headers: _authHeaders);
        if (res.statusCode == 200 && res.body.isNotEmpty) {
          yield jsonDecode(res.body) as Map<String, dynamic>;
        }
      } catch (_) {
        // A transient poll failure doesn't end the stream — ConnectionManager
        // owns overall connection-health decisions via authenticate()/
        // sendCommand() failures, not this best-effort polling loop.
      }
    }
  }
}
