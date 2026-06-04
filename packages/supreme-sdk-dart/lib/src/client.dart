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
