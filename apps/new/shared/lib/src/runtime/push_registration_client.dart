import 'dart:convert';
import 'package:http/http.dart' as http;

/// Real client for the EXISTING server-side push contract
/// (`POST /v1/push/tokens`, `DELETE /v1/push/tokens/:token` —
/// `services/gateway/src/routes/notifications.ts`) — no second push protocol was invented
/// (§Phase12.5 §6/§21). Registers/removes ONE device's push token for ONE Home, authenticated
/// with THAT Home's own Mobile-authorization bearer token — this phase wired
/// `authenticateMobileOrUser` (Phase 12.4's bridge) into both push routes, alongside the
/// existing session-only path, so this call works with either credential.
///
/// HONEST STATUS: this is REAL/IMPLEMENTED client-side HTTP plumbing against a REAL server
/// route. What determines whether a push actually arrives is `services/notifications`'
/// `PushService`/`IPushProvider` — real architecture (`RelayPushProvider` forwards to an
/// optional Supreme Cloud relay so the Hub never holds FCM/APNs secrets), but NO concrete
/// FCM/APNs provider is wired into any environment in this repository today (no
/// `firebase-admin`/APNs SDK dependency exists) — so end-to-end push delivery is
/// **BACKEND/PLATFORM CONTRACT MISSING**, not fabricated as working here.
class PushRegistrationClient {
  final http.Client _client;

  PushRegistrationClient({http.Client? client})
      : _client = client ?? http.Client();

  /// [baseUrl] is the TARGET Home's own Hub/broker address — never a single shared URL, since
  /// every paired Home is a different Hub (§3: this call must reach that specific Home).
  Future<void> register({
    required Uri baseUrl,
    required String bearerToken,
    required String platform,
    required String token,
  }) async {
    final res = await _client
        .post(
          baseUrl.resolve('/v1/push/tokens'),
          headers: {
            'content-type': 'application/json',
            'authorization': 'Bearer $bearerToken'
          },
          body: jsonEncode({'platform': platform, 'token': token}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      throw StateError(
          'push token registration failed: HTTP ${res.statusCode}');
    }
  }

  Future<void> unregister(
      {required Uri baseUrl,
      required String bearerToken,
      required String token}) async {
    final res = await _client.delete(
      baseUrl.resolve('/v1/push/tokens/${Uri.encodeComponent(token)}'),
      headers: {'authorization': 'Bearer $bearerToken'},
    );
    if (res.statusCode >= 400 && res.statusCode != 404) {
      throw StateError('push token removal failed: HTTP ${res.statusCode}');
    }
  }
}
