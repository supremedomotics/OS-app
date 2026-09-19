import 'dart:convert';
import 'package:test/test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// §Phase12.5 §6 — proves the client speaks the REAL `/v1/push/tokens` contract
/// (`services/gateway/src/routes/notifications.ts`), authenticated with a Home-scoped bearer
/// token, never a shared credential.
void main() {
  group('PushRegistrationClient against the real /v1/push/tokens contract', () {
    test('register() posts the real body with the Home-scoped bearer token',
        () async {
      Uri? capturedUri;
      String? capturedAuth;
      String? capturedBody;
      final client = MockClient((req) async {
        capturedUri = req.url;
        capturedAuth = req.headers['authorization'];
        capturedBody = req.body;
        return http.Response(
            jsonEncode({'registered': true, 'pushEnabled': true}), 201);
      });
      final registrationClient = PushRegistrationClient(client: client);

      await registrationClient.register(
        baseUrl: Uri.parse('https://192.168.1.50'),
        bearerToken: 'tok-for-hub-a',
        platform: 'fcm',
        token: 'device-token-abc',
      );

      expect(capturedUri!.path, '/v1/push/tokens');
      expect(capturedAuth, 'Bearer tok-for-hub-a');
      expect(jsonDecode(capturedBody!),
          {'platform': 'fcm', 'token': 'device-token-abc'});
    });

    test('register() throws on a server error, never silently succeeding',
        () async {
      final client = MockClient((req) async => http.Response('', 500));
      final registrationClient = PushRegistrationClient(client: client);

      expect(
        registrationClient.register(
            baseUrl: Uri.parse('https://192.168.1.50'),
            bearerToken: 'tok',
            platform: 'fcm',
            token: 't'),
        throwsStateError,
      );
    });

    test('unregister() deletes the real path with the token URL-encoded',
        () async {
      Uri? capturedUri;
      final client = MockClient((req) async {
        capturedUri = req.url;
        return http.Response('', 204);
      });
      final registrationClient = PushRegistrationClient(client: client);

      await registrationClient.unregister(
          baseUrl: Uri.parse('https://192.168.1.50'),
          bearerToken: 'tok',
          token: 'a token/with special+chars');

      expect(capturedUri!.path,
          '/v1/push/tokens/a%20token%2Fwith%20special%2Bchars');
    });

    test('unregister() tolerates a 404 (already removed) without throwing',
        () async {
      final client = MockClient((req) async => http.Response('', 404));
      final registrationClient = PushRegistrationClient(client: client);

      await registrationClient.unregister(
          baseUrl: Uri.parse('https://192.168.1.50'),
          bearerToken: 'tok',
          token: 't');
    });
  });
}
