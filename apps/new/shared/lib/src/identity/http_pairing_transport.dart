import 'dart:convert';
import 'package:http/http.dart' as http;

import 'pairing.dart';

/// Real HTTP implementation of [PairingTransport] (§Phase12.2 §4) against the actual server
/// routes Phase 12 shipped in `services/gateway/src/routes/pairing.ts`:
/// `POST {baseUrl}/v1/pairing/challenge` and `POST {baseUrl}/v1/pairing/verify`. This is the
/// piece Phase 11/12's doc comments named as the one thing still missing from
/// `PairingClient` — a transport that actually talks to a Hub, not a fake.
///
/// `baseUrl` is a plain LAN Hub address (e.g. `https://192.168.1.50`, from
/// `DiscoveredHub.controlUri` — but see the class-level note on port below), never a
/// broker/remote URL: initial pairing is deliberately a LAN-only ceremony (§Phase12.2 §8) —
/// the Hub's own `/v1/pairing/*` routes are reachable over the broker's
/// `/v1/route/:hubId/*` forward too, but forwarding through the broker requires a Mobile
/// bearer token that does not exist yet at pairing time (a chicken-and-egg the real broker
/// authorizer would otherwise have to weaken to solve — see `mobile-pairing.ts`'s own doc
/// comment on this exact point). This is a deliberate security boundary, not an oversight.
///
/// HONEST STATUS: `DiscoveredHub.controlUri` defaults to
/// [SupremeOSHubDefaults.defaultPort] (7272, the native/local client port), but the real
/// `/v1/pairing/*` routes are served by the existing gateway (Caddy :443 / internal :8080),
/// NOT :7272 — no native 7272 pairing listener exists yet (§Phase9's own documented gap).
/// Callers must therefore pass the Hub's actual gateway base URL (typically `https://<lan-ip>`
/// on 443), not blindly `discoveredHub.controlUri` — this class does not paper over that
/// mismatch by guessing a port.
class HttpPairingTransport implements PairingTransport {
  final Uri baseUrl;
  final http.Client _client;

  HttpPairingTransport({required this.baseUrl, http.Client? client})
      : _client = client ?? http.Client();

  Uri _route(String path) => baseUrl.resolve(path);

  @override
  Future<PairingChallengeResponse> requestChallenge(
      {required String pairingCode,
      required String mobilePublicKeyBase64}) async {
    final res = await _client
        .post(
          _route('/v1/pairing/challenge'),
          headers: {'content-type': 'application/json'},
          body: jsonEncode({
            'pairingCode': pairingCode,
            'mobilePublicKeyBase64': mobilePublicKeyBase64
          }),
        )
        .timeout(const Duration(seconds: 10));

    if (res.statusCode != 200) {
      throw PairingException(_errorMessage(res, 'pairing code was rejected'));
    }
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return PairingChallengeResponse(
      challengeId: body['challengeId'] as String,
      challengeBytes: base64Decode(body['challengeBytes'] as String),
      hubId: body['hubId'] as String,
      projectId: body['projectId'] as String,
    );
  }

  @override
  Future<MobileAuthorization> submitSignedChallenge(
      {required String challengeId, required String signatureBase64}) async {
    final res = await _client
        .post(
          _route('/v1/pairing/verify'),
          headers: {'content-type': 'application/json'},
          body: jsonEncode(
              {'challengeId': challengeId, 'signatureBase64': signatureBase64}),
        )
        .timeout(const Duration(seconds: 10));

    if (res.statusCode != 200) {
      throw PairingException(_errorMessage(res, 'signature was rejected'));
    }
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return MobileAuthorization(
      mobileId: body['mobileId'] as String,
      hubId: body['hubId'] as String,
      projectId: body['projectId'] as String,
      token: body['token'] as String,
      issuedAt: DateTime.parse(body['issuedAt'] as String),
    );
  }

  String _errorMessage(http.Response res, String fallback) {
    try {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final message = body['message'];
      if (message is String) return message;
    } catch (_) {
      // fall through to the generic message below
    }
    return '$fallback (HTTP ${res.statusCode})';
  }
}
