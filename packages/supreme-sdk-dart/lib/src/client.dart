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

  /// All devices in the home (flat, permission-filtered).
  Future<List<Device>> devices() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/devices'),
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

  /// Apply the current circadian (human-centric) lighting target to every tunable-white
  /// light, optionally scoped to [roomId]. Returns the ids of the lights that were set.
  Future<List<String>> applyCircadian({String? roomId}) async {
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/lighting/circadian/apply'),
      headers: _authHeaders,
      body: jsonEncode({if (roomId != null) 'roomId': roomId}),
    );
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['applied'] as List<dynamic>).cast<String>();
  }

  /// The home's scene schedules (time / sunrise / sunset triggers).
  Future<List<Map<String, dynamic>>> sceneSchedules() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/scenes/schedules'),
        headers: _authHeaders);
    _ensureOk(res);
    return ((jsonDecode(res.body) as Map<String, dynamic>)['schedules']
            as List<dynamic>)
        .cast<Map<String, dynamic>>();
  }

  /// Replace the home's scene schedules.
  Future<void> setSceneSchedules(List<Map<String, dynamic>> schedules) async {
    final res = await _http.put(
      Uri.parse('$baseUrl/v1/scenes/schedules'),
      headers: _authHeaders,
      body: jsonEncode({'schedules': schedules}),
    );
    _ensureOk(res);
  }

  /// The home's duration-based alert rules (door left open/unlocked, light left on).
  Future<List<Map<String, dynamic>>> alertRules() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/alerts/rules'),
        headers: _authHeaders);
    _ensureOk(res);
    return ((jsonDecode(res.body) as Map<String, dynamic>)['rules']
            as List<dynamic>)
        .cast<Map<String, dynamic>>();
  }

  /// Replace the home's alert rules.
  Future<void> setAlertRules(List<Map<String, dynamic>> rules) async {
    final res = await _http.put(
      Uri.parse('$baseUrl/v1/alerts/rules'),
      headers: _authHeaders,
      body: jsonEncode({'rules': rules}),
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

  /// Tariff-aware energy cost for the home: pass the homeowner's [tariff] (and an
  /// optional [budget] / date range) and get a cost breakdown + budget projection.
  Future<Map<String, dynamic>> energyCost(
    Map<String, dynamic> tariff, {
    Map<String, dynamic>? budget,
    String? from,
    String? to,
  }) async {
    final res = await _http.post(
      Uri.parse('$baseUrl/v1/energy/cost'),
      headers: _authHeaders,
      body: jsonEncode({
        'tariff': tariff,
        if (budget != null) 'budget': budget,
        if (from != null) 'from': from,
        if (to != null) 'to': to,
      }),
    );
    _ensureOk(res);
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// The home's electricity-provider rate config, or null if not set up.
  Future<Map<String, dynamic>?> energyProvider() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/energy/provider'),
        headers: _authHeaders);
    _ensureOk(res);
    return (jsonDecode(res.body) as Map<String, dynamic>)['provider']
        as Map<String, dynamic>?;
  }

  /// Set the electricity provider (country/city/provider) → resolves the per-kWh rate.
  Future<Map<String, dynamic>> setEnergyProvider({
    required String country,
    String? city,
    String? provider,
    double? ratePerKwh,
  }) async {
    final res = await _http.put(
      Uri.parse('$baseUrl/v1/energy/provider'),
      headers: _authHeaders,
      body: jsonEncode({
        'country': country,
        if (city != null) 'city': city,
        if (provider != null) 'provider': provider,
        if (ratePerKwh != null) 'ratePerKwh': ratePerKwh,
      }),
    );
    _ensureOk(res);
    return (jsonDecode(res.body) as Map<String, dynamic>)['provider']
        as Map<String, dynamic>;
  }

  /// Cost breakdown grouped per `device` or `room` over an optional range.
  Future<Map<String, dynamic>> energyBreakdown(String groupBy,
      {String? from, String? to}) async {
    final q = {
      'groupBy': groupBy,
      if (from != null) 'from': from,
      if (to != null) 'to': to,
    };
    final res = await _http.get(
        Uri.parse('$baseUrl/v1/energy/breakdown').replace(queryParameters: q),
        headers: _authHeaders);
    _ensureOk(res);
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Cost history bucketed by `day` | `week` | `month` | `year`, optionally for one device.
  Future<Map<String, dynamic>> energyHistory(String bucket,
      {String? from, String? to, String? deviceId}) async {
    final q = {
      'bucket': bucket,
      if (from != null) 'from': from,
      if (to != null) 'to': to,
      if (deviceId != null) 'deviceId': deviceId,
    };
    final res = await _http.get(
        Uri.parse('$baseUrl/v1/energy/history').replace(queryParameters: q),
        headers: _authHeaders);
    _ensureOk(res);
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// The home's climate program (programmable-thermostat setpoint schedule), or null.
  Future<Map<String, dynamic>?> climateProgram() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/climate/program'),
        headers: _authHeaders);
    _ensureOk(res);
    return (jsonDecode(res.body) as Map<String, dynamic>)['program']
        as Map<String, dynamic>?;
  }

  /// Replace the home's climate program ({weekday:[{atMinutes,targetC}], weekend:[...]}).
  Future<void> setClimateProgram(Map<String, dynamic> program) async {
    final res = await _http.put(
      Uri.parse('$baseUrl/v1/climate/program'),
      headers: _authHeaders,
      body: jsonEncode({'program': program}),
    );
    _ensureOk(res);
  }

  /// Current security panel state.
  Future<Map<String, dynamic>> securityState() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/security'),
        headers: _authHeaders);
    _ensureOk(res);
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Whether occupancy (vacation) simulation is currently running.
  Future<bool> occupancyRunning() async {
    final res = await _http.get(Uri.parse('$baseUrl/v1/security/occupancy'),
        headers: _authHeaders);
    _ensureOk(res);
    return (jsonDecode(res.body) as Map<String, dynamic>)['running'] as bool? ??
        false;
  }

  /// Turn occupancy (vacation) simulation on or off.
  Future<void> setOccupancy(bool enabled) async {
    final res = await _http.post(
      Uri.parse(
          '$baseUrl/v1/security/occupancy/${enabled ? 'enable' : 'disable'}'),
      headers: _authHeaders,
      body: jsonEncode({}),
    );
    _ensureOk(res);
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
