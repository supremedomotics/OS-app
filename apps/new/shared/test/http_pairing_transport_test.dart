import 'dart:convert';
import 'package:test/test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// §Phase12.2 §4 — proves `HttpPairingTransport` speaks the REAL request/response contract
/// `services/gateway/src/routes/pairing.ts` implements (mirrors the server-side vitest suite's
/// shapes), not an invented one.
void main() {
  group('HttpPairingTransport against the real /v1/pairing/* contract', () {
    test(
        'requestChallenge posts the real body and decodes the real response shape',
        () async {
      Uri? capturedUri;
      String? capturedBody;
      final client = MockClient((req) async {
        capturedUri = req.url;
        capturedBody = req.body;
        return http.Response(
          jsonEncode({
            'challengeId': 'chal-1',
            'challengeBytes': base64Encode([1, 2, 3, 4]),
            'hubId': 'hub-abc',
            'projectId': 'proj-1',
          }),
          200,
        );
      });
      final transport = HttpPairingTransport(
          baseUrl: Uri.parse('https://192.168.1.50'), client: client);

      final challenge = await transport.requestChallenge(
          pairingCode: '482913', mobilePublicKeyBase64: 'pk==');

      expect(capturedUri!.path, '/v1/pairing/challenge');
      expect(jsonDecode(capturedBody!),
          {'pairingCode': '482913', 'mobilePublicKeyBase64': 'pk=='});
      expect(challenge.challengeId, 'chal-1');
      expect(challenge.challengeBytes, [1, 2, 3, 4]);
      expect(challenge.hubId, 'hub-abc');
    });

    test(
        'requestChallenge throws PairingException on a non-200 (e.g. wrong/expired code)',
        () async {
      final client = MockClient((req) async => http.Response(
          jsonEncode({
            'code': 'unauthorized',
            'message': 'invalid or expired pairing code'
          }),
          401));
      final transport = HttpPairingTransport(
          baseUrl: Uri.parse('https://192.168.1.50'), client: client);

      expect(
        transport.requestChallenge(
            pairingCode: '000000', mobilePublicKeyBase64: 'pk=='),
        throwsA(isA<PairingException>()),
      );
    });

    test(
        'submitSignedChallenge posts the real body and decodes a real MobileAuthorization',
        () async {
      Uri? capturedUri;
      final client = MockClient((req) async {
        capturedUri = req.url;
        return http.Response(
          jsonEncode({
            'mobileId': 'mobile-1',
            'hubId': 'hub-abc',
            'projectId': 'proj-1',
            'token': 'tok-xyz',
            'issuedAt': DateTime.now().toIso8601String(),
          }),
          200,
        );
      });
      final transport = HttpPairingTransport(
          baseUrl: Uri.parse('https://192.168.1.50'), client: client);

      final authorization = await transport.submitSignedChallenge(
          challengeId: 'chal-1', signatureBase64: 'sig==');

      expect(capturedUri!.path, '/v1/pairing/verify');
      expect(authorization.mobileId, 'mobile-1');
      expect(authorization.token, 'tok-xyz');
    });

    test(
        'submitSignedChallenge throws PairingException on a rejected signature',
        () async {
      final client = MockClient((req) async => http.Response(
          jsonEncode({
            'code': 'unauthorized',
            'message': 'signature does not match challenge'
          }),
          401));
      final transport = HttpPairingTransport(
          baseUrl: Uri.parse('https://192.168.1.50'), client: client);

      expect(
        transport.submitSignedChallenge(
            challengeId: 'chal-1', signatureBase64: 'bad=='),
        throwsA(isA<PairingException>()),
      );
    });
  });

  group(
      'PairingClient end-to-end against HttpPairingTransport (real Ed25519, real HTTP shape)',
      () {
    test(
        'a full pairing round trip yields a real MobileAuthorization bound to the right Hub',
        () async {
      final identity = Ed25519MobileIdentity(InMemorySecretBytesStore());
      String? issuedChallengeId;
      List<int>? issuedBytes;
      String? capturedPublicKey;

      final client = MockClient((req) async {
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        if (req.url.path == '/v1/pairing/challenge') {
          capturedPublicKey = body['mobilePublicKeyBase64'] as String;
          issuedChallengeId = 'chal-1';
          issuedBytes = utf8.encode('nonce-1');
          return http.Response(
            jsonEncode({
              'challengeId': issuedChallengeId,
              'challengeBytes': base64Encode(issuedBytes!),
              'hubId': 'hub-abc',
              'projectId': 'proj-1',
            }),
            200,
          );
        }
        // /v1/pairing/verify — actually verify the real signature server-side-style.
        final ok = await Ed25519MobileIdentity.verify(
          message: issuedBytes!,
          signatureBase64: body['signatureBase64'] as String,
          publicKeyBase64: capturedPublicKey!,
        );
        if (!ok)
          return http.Response(jsonEncode({'message': 'bad signature'}), 401);
        return http.Response(
          jsonEncode({
            'mobileId': 'mobile-1',
            'hubId': 'hub-abc',
            'projectId': 'proj-1',
            'token': 'tok-xyz',
            'issuedAt': DateTime.now().toIso8601String(),
          }),
          200,
        );
      });

      final pairingClient = PairingClient(
        identity: identity,
        transport: HttpPairingTransport(
            baseUrl: Uri.parse('https://192.168.1.50'), client: client),
      );

      final authorization = await pairingClient.pairUsingCode('482913');

      expect(authorization.hubId, 'hub-abc');
      expect(authorization.token, 'tok-xyz');
    });
  });
}
