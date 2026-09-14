import 'dart:convert';
import 'package:test/test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// Tests against the REAL request contract of `cloud/tunnel-broker/src/server.ts`'s
/// `/v1/route/:hubId/*` route (§Phase10-19/22) — a `MockClient` stands in for
/// the network, but the request shapes/status codes asserted here are the
/// broker's actual documented behavior, not an invented one.
void main() {
  RemoteHubConfig configWith(http.Client client, {String token = 'tok-123'}) {
    return RemoteHubConfig(
      brokerUrl: Uri.parse('https://broker.example.com'),
      hubId: 'hub-abc',
      bearerToken: () => token,
    );
  }

  group('RemoteHubConfig.streamUri() (§Phase12.9)', () {
    test('builds a wss:// URL against the broker\'s stream route', () {
      final config = configWith(MockClient((_) async => http.Response('', 200)));
      expect(config.streamUri().toString(),
          'wss://broker.example.com/v1/route/hub-abc/stream');
    });

    test('preserves ws:// for a non-TLS broker (local dev/test)', () {
      final config = RemoteHubConfig(
        brokerUrl: Uri.parse('http://localhost:9999'),
        hubId: 'hub-abc',
        bearerToken: () => 'tok',
      );
      expect(config.streamUri().toString(),
          'ws://localhost:9999/v1/route/hub-abc/stream');
    });
  });

  group('RemoteHubTransport against the real broker route contract', () {
    test('authenticate() succeeds on a 200 from /v1/route/:hubId/healthz',
        () async {
      final client = MockClient((req) async {
        expect(req.url.path, '/v1/route/hub-abc/healthz');
        expect(req.headers['Authorization'], 'Bearer tok-123');
        return http.Response('ok', 200);
      });
      final transport =
          RemoteHubTransport(config: configWith(client), client: client);

      await transport.connect();
      await transport.authenticate();

      expect(transport.isConnected, isTrue);
    });

    test(
        'authenticate() throws AuthenticationException on the broker\'s 403 (not authorized)',
        () async {
      final client = MockClient((req) async => http.Response('forbidden', 403));
      final transport =
          RemoteHubTransport(config: configWith(client), client: client);

      await transport.connect();
      expect(transport.authenticate(), throwsA(isA<AuthenticationException>()));
    });

    test('authenticate() surfaces the broker\'s 503 (hub_offline) distinctly',
        () async {
      final client = MockClient((req) async => http.Response('offline', 503));
      final transport =
          RemoteHubTransport(config: configWith(client), client: client);

      await transport.connect();
      await expectLater(
        transport.authenticate(),
        throwsA(predicate((e) => e.toString().contains('hub_offline'))),
      );
    });

    test('sendCommand posts to /v1/route/:hubId/:path with the bearer token',
        () async {
      String? capturedPath;
      String? capturedAuth;
      String? capturedBody;
      final client = MockClient((req) async {
        if (req.url.path.endsWith('healthz')) return http.Response('ok', 200);
        capturedPath = req.url.path;
        capturedAuth = req.headers['Authorization'];
        capturedBody = req.body;
        return http.Response(jsonEncode({'ok': true}), 200);
      });
      final transport =
          RemoteHubTransport(config: configWith(client), client: client);
      await transport.connect();
      await transport.authenticate();

      final result = await transport
          .sendCommand('v1/rooms/living-room/lighting', {'on': true});

      expect(capturedPath, '/v1/route/hub-abc/v1/rooms/living-room/lighting');
      expect(capturedAuth, 'Bearer tok-123');
      expect(capturedBody, jsonEncode({'on': true}));
      expect(result, {'ok': true});
    });

    test('sendCommand throws before authenticate() has succeeded', () async {
      final client = MockClient((req) async => http.Response('', 200));
      final transport =
          RemoteHubTransport(config: configWith(client), client: client);
      expect(() => transport.sendCommand('v1/x', {}), throwsStateError);
    });

    test('a mid-session hub_offline on a command is a real, surfaced error',
        () async {
      final client = MockClient((req) async {
        if (req.url.path.endsWith('healthz')) return http.Response('ok', 200);
        return http.Response('offline', 503);
      });
      final transport =
          RemoteHubTransport(config: configWith(client), client: client);
      await transport.connect();
      await transport.authenticate();

      expect(transport.sendCommand('v1/x', {}), throwsStateError);
    });
  });

  group('ConnectionManager end-to-end with the real RemoteHubTransport', () {
    test('falls back to the real remote transport when no LAN Hub is found',
        () async {
      final client = MockClient((req) async => http.Response('ok', 200));
      final manager = ConnectionManager(
        discovery: const MockHubDiscovery(hubPresent: false),
        makeLanTransport: (_) => MockHubTransport(),
        makeRemoteTransport: () =>
            RemoteHubTransport(config: configWith(client), client: client),
        remoteAccessEnabled: true,
      );

      await manager.start();

      expect(manager.current.status, ConnectionStatus.connectedRemote);
      await manager.dispose();
    });

    test(
        'a Hub the account is not authorized for lands on authenticationFailed remotely',
        () async {
      final client = MockClient((req) async => http.Response('forbidden', 403));
      final manager = ConnectionManager(
        discovery: const MockHubDiscovery(hubPresent: false),
        makeLanTransport: (_) => MockHubTransport(),
        makeRemoteTransport: () =>
            RemoteHubTransport(config: configWith(client), client: client),
        remoteAccessEnabled: true,
      );

      await manager.start();

      expect(manager.current.status, ConnectionStatus.authenticationFailed);
      await manager.dispose();
    });
  });
}
