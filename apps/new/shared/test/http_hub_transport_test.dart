import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// §Phase12.8 — a REAL local `dart:io` HTTP server, not a mock, proving `HttpHubTransport`
/// speaks real HTTP against the real Hub REST verb contract (GET for reads, POST for commands).
void main() {
  late HttpServer server;
  late Uri baseUrl;
  String? seenAuth;
  String? lastMethod;
  String? lastPath;
  String? lastBody;
  int nextStatus = 200;
  Map<String, dynamic> nextBody = const {};

  setUp(() async {
    seenAuth = null;
    nextStatus = 200;
    nextBody = const {};
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      seenAuth = req.headers.value('authorization');
      lastMethod = req.method;
      lastPath = req.uri.path;
      lastBody = await utf8.decodeStream(req);
      req.response.statusCode = nextStatus;
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode(nextBody));
      await req.response.close();
    });
    baseUrl = Uri.parse('http://127.0.0.1:${server.port}');
  });

  tearDown(() async {
    await server.close(force: true);
  });

  group('HttpHubTransport — against a REAL local HTTP server', () {
    test(
        'authenticate() sends a real GET to v1/home with the real bearer token',
        () async {
      nextBody = {'home': {}, 'rooms': []};
      final transport =
          HttpHubTransport(baseUrl: baseUrl, bearerToken: () => 'real-token');

      await transport.connect();
      await transport.authenticate();

      expect(seenAuth, 'Bearer real-token');
      expect(lastMethod, 'GET');
      expect(lastPath, '/v1/home');
      expect(transport.isConnected, isTrue);
    });

    test('authenticate() throws AuthenticationException on a real 401',
        () async {
      nextStatus = 401;
      final transport =
          HttpHubTransport(baseUrl: baseUrl, bearerToken: () => 'bad-token');

      await transport.connect();
      expect(transport.authenticate(), throwsA(isA<AuthenticationException>()));
    });

    test('get() performs a real GET and decodes the real JSON response',
        () async {
      nextBody = {'devices': []};
      final transport =
          HttpHubTransport(baseUrl: baseUrl, bearerToken: () => 'tok');
      await transport.connect();
      await transport.authenticate();

      final result = await transport.get('v1/devices');

      expect(lastMethod, 'GET');
      expect(lastPath, '/v1/devices');
      expect(result, {'devices': []});
    });

    test('sendCommand() performs a real POST with the real command body',
        () async {
      nextBody = {'accepted': true};
      final transport =
          HttpHubTransport(baseUrl: baseUrl, bearerToken: () => 'tok');
      await transport.connect();
      await transport.authenticate();

      final result = await transport.sendCommand('v1/devices/dev-1/command', {
        'command': {'capability': 'onoff', 'action': 'on'}
      });

      expect(lastMethod, 'POST');
      expect(lastPath, '/v1/devices/dev-1/command');
      expect(jsonDecode(lastBody!), {
        'command': {'capability': 'onoff', 'action': 'on'}
      });
      expect(result, {'accepted': true});
    });

    test('get() throws before authenticate() has succeeded', () async {
      final transport =
          HttpHubTransport(baseUrl: baseUrl, bearerToken: () => 'tok');
      expect(() => transport.get('v1/home'), throwsStateError);
    });
  });
}
