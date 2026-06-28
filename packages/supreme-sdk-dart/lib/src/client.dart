import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

/// Typed REST client for the Supreme API. Stores the access/refresh tokens in
/// memory; the app layer persists them in secure storage.
class SupremeClient {
  SupremeClient({required this.baseUrl, http.Client? httpClient})
      : _http = httpClient ?? http.Client();

  final String baseUrl;
  final http.Client _http;

  String? _accessToken;
  String? _refreshToken;

  String? get accessToken => _accessToken;

  /// Apply an externally-obtained access token (e.g. a cloud identity-plane session reused
  /// across homes), so a client targeting a freshly-resolved hub base URL is authenticated
  /// without re-running [login]. The hub validates the token locally on each request.
  set accessToken(String? token) => _accessToken = token;

  Map<String, String> get _authHeaders => {
        'content-type': 'application/json',
        if (_accessToken != null) 'authorization': 'Bearer $_accessToken',
      };

  /// Returns true when login completed with tokens; false when MFA is required.
  Future<bool> login(String email, String password) async {
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/auth/login'),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({'email': email, 'password': password}),
    );
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (body['status'] == 'ok') {
      _accessToken = body['accessToken'] as String;
      _refreshToken = body['refreshToken'] as String;
      return true;
    }
    return false; // mfa_required
  }

  Future<HomeView> home() async {
    final res =
        await _http.get(Uri.parse('$baseUrl/v1/home'), headers: _authHeaders);
    _ensureOk(res);
    return HomeView.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  /// Exchange the stored refresh token for a fresh access/refresh pair.
  Future<void> refresh() async {
    if (_refreshToken == null) {
      throw SupremeApiException(401, 'no refresh token');
    }
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/auth/refresh'),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({'refreshToken': _refreshToken}),
    );
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    _accessToken = body['accessToken'] as String;
    _refreshToken = body['refreshToken'] as String;
  }

  Future<List<Device>> devicesInRoom(String roomId) async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/rooms/$roomId/devices'),
        headers: _authHeaders);
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['devices'] as List<dynamic>)
        .map((d) => Device.fromJson(d as Map<String, dynamic>))
        .toList();
  }

  /// The core control verb — tap a light, set a level.
  Future<void> command(String deviceId, Map<String, dynamic> command) async {
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/devices/$deviceId/command'),
      headers: _authHeaders,
      body: jsonEncode({'command': command}),
    );
    _ensureOk(res);
  }

  /// Move a device to any room and/or rename it (owner/admin/installer).
  Future<Device> updateDevice(String deviceId, {String? name, String? roomId}) async {
    final res = await _http.patch(
      Uri.parse('$baseUrl/v1/devices/$deviceId'),
      headers: _authHeaders,
      body: jsonEncode({
        if (name != null) 'name': name,
        if (roomId != null) 'roomId': roomId,
      }),
    );
    _ensureOk(res);
    return Device.fromJson((jsonDecode(res.body) as Map<String, dynamic>)['device'] as Map<String, dynamic>);
  }

  /// Delete a device (also drops its backend bindings).
  Future<void> deleteDevice(String deviceId) async {
    final res = await _http.delete(Uri.parse('$baseUrl/v1/devices/$deviceId'), headers: _authHeaders);
    _ensureOk(res);
  }

  // ── Scenes ─────────────────────────────────────────────────────────────────
  Future<List<Scene>> scenes() async {
    final res =
        await _http.get(Uri.parse('$baseUrl/v1/scenes'), headers: _authHeaders);
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['scenes'] as List<dynamic>)
        .map((s) => Scene.fromJson(s as Map<String, dynamic>))
        .toList();
  }

  Future<void> activateScene(String sceneId) async {
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/scenes/$sceneId/activate'),
      headers: _authHeaders,
    );
    _ensureOk(res);
  }

  // ── Favorites ────────────────────────────────────────────────────────────────
  Future<List<Favorite>> favorites() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/favorites'),
        headers: _authHeaders);
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['favorites'] as List<dynamic>)
        .map((f) => Favorite.fromJson(f as Map<String, dynamic>))
        .toList();
  }

  Future<void> setFavorite(Map<String, dynamic> ref,
      {required bool favorite}) async {
    final res = await _http.put(
      Uri.parse('$baseUrl/v1/favorites'),
      headers: _authHeaders,
      body: jsonEncode({'ref': ref, 'favorite': favorite}),
    );
    _ensureOk(res);
  }

  // ── Notifications ────────────────────────────────────────────────────────────
  Future<List<NotificationItem>> notifications() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/notifications'),
        headers: _authHeaders);
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['notifications'] as List<dynamic>)
        .map((n) => NotificationItem.fromJson(n as Map<String, dynamic>))
        .toList();
  }

  // ── Automations (visual Builder, §10) ────────────────────────────────────────
  Future<List<AutomationSummary>> automations() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/automations'),
        headers: _authHeaders);
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['automations'] as List<dynamic>)
        .map((a) => AutomationSummary.fromJson(a as Map<String, dynamic>))
        .toList();
  }

  Future<void> createAutomation(Map<String, dynamic> body) async {
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/automations'),
      headers: _authHeaders,
      body: jsonEncode(body),
    );
    _ensureOk(res);
  }

  Future<void> setAutomationEnabled(String id, bool enabled) async {
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/automations/$id/enabled'),
      headers: _authHeaders,
      body: jsonEncode({'enabled': enabled}),
    );
    _ensureOk(res);
  }

  Future<void> runAutomation(String id) async {
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/automations/$id/run'),
      headers: _authHeaders,
    );
    _ensureOk(res);
  }

  Future<void> deleteAutomation(String id) async {
    final res = await _http.delete(Uri.parse('$baseUrl/v1/automations/$id'),
        headers: _authHeaders);
    _ensureOk(res);
  }

  // ── Intelligence & scale (Phase 3) ───────────────────────────────────────────

  /// Ask the on-box assistant; returns the draft result map (kind + payload).
  Future<Map<String, dynamic>> aiAssist(String utterance) async {
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/ai/assistant'),
      headers: _authHeaders,
      body: jsonEncode({'utterance': utterance}),
    );
    _ensureOk(res);
    return (jsonDecode(res.body) as Map<String, dynamic>)['result']
        as Map<String, dynamic>;
  }

  /// Per-measure energy summary for the home.
  Future<List<Map<String, dynamic>>> energySummary() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/energy/summary'),
        headers: _authHeaders);
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['summary'] as List<dynamic>).cast<Map<String, dynamic>>();
  }

  /// Current security panel state.
  Future<Map<String, dynamic>> securityState() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/security'),
        headers: _authHeaders);
    _ensureOk(res);
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> arm(String mode, {String? pin}) async {
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/security/arm'),
      headers: _authHeaders,
      body: jsonEncode({'mode': mode, if (pin != null) 'pin': pin}),
    );
    _ensureOk(res);
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> disarm({String? pin}) async {
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/security/disarm'),
      headers: _authHeaders,
      body: jsonEncode({if (pin != null) 'pin': pin}),
    );
    _ensureOk(res);
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  // ── Cameras (§11.1) ──────────────────────────────────────────────────────────
  Future<List<Camera>> cameras() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/cameras'),
        headers: _authHeaders);
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['cameras'] as List<dynamic>)
        .map((c) => Camera.fromJson(c as Map<String, dynamic>))
        .toList();
  }

  /// Resolve a camera's RTSP source into client-playable HLS/WebRTC streams.
  Future<List<CameraStream>> cameraStream(String id) async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/cameras/$id/stream'),
        headers: _authHeaders);
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['streams'] as List<dynamic>)
        .map((s) => CameraStream.fromJson(s as Map<String, dynamic>))
        .toList();
  }

  // ── Push notifications (§13) ─────────────────────────────────────────────────
  /// Register this device's push token (platform: "fcm" | "apns" | "webpush") so
  /// notifications reach it while the app is backgrounded. Returns whether the hub has
  /// push delivery enabled (false = on-LAN WSS only).
  Future<bool> registerPushToken(String platform, String token) async {
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/push/tokens'),
      headers: _authHeaders,
      body: jsonEncode({'platform': platform, 'token': token}),
    );
    _ensureOk(res);
    return (jsonDecode(res.body) as Map<String, dynamic>)['pushEnabled'] as bool? ??
        false;
  }

  Future<void> unregisterPushToken(String token) async {
    final res = await _http.delete(
      Uri.parse('$baseUrl/v1/push/tokens/${Uri.encodeComponent(token)}'),
      headers: _authHeaders,
    );
    _ensureOk(res);
  }

  void _ensureOk(http.Response res) {
    if (res.statusCode >= 400) {
      throw SupremeApiException(res.statusCode, res.body);
    }
  }
}

class SupremeApiException implements Exception {
  SupremeApiException(this.statusCode, this.body);
  final int statusCode;
  final String body;

  @override
  String toString() => 'SupremeApiException($statusCode): $body';
}
