import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supreme_sdk/supreme_sdk.dart';
import 'package:test/test.dart';

/// The access token is short-lived (15 min) by design; every command must survive it expiring
/// mid-session by silently refreshing and retrying — never leaving a device stuck (or, worse, the
/// app looking "logged in" while every request quietly 401s). This is the fix for a bug where the
/// Dart SDK never refreshed at all.
http.Response _json(int status, Map<String, dynamic> body) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

void main() {
  test('refreshes once and retries a command that 401s on an expired access token', () async {
    final paths = <String>[];
    final client = SupremeClient(
      baseUrl: 'http://hub.local',
      httpClient: MockClient((req) async {
        paths.add(req.url.path);
        final auth = req.headers['authorization'];
        if (req.url.path == '/v1/devices/dev1/command' && auth == 'Bearer stale') {
          return _json(401, {'code': 'unauthorized', 'message': 'token expired'});
        }
        if (req.url.path == '/v1/auth/refresh') {
          return _json(200, {'accessToken': 'fresh', 'refreshToken': 'refresh2', 'expiresIn': 900, 'tokenType': 'Bearer'});
        }
        if (req.url.path == '/v1/devices/dev1/command' && auth == 'Bearer fresh') {
          return _json(200, {'accepted': true});
        }
        throw StateError('unexpected request: ${req.url.path}');
      }),
    );
    client.restoreTokens(accessToken: 'stale', refreshToken: 'refresh1');

    await client.command('dev1', {'capability': 'onoff', 'action': 'on'});

    expect(paths, ['/v1/devices/dev1/command', '/v1/auth/refresh', '/v1/devices/dev1/command']);
    expect(client.accessToken, 'fresh');
  });

  test('shares one refresh across concurrent 401s instead of racing the refresh endpoint', () async {
    var refreshCalls = 0;
    final client = SupremeClient(
      baseUrl: 'http://hub.local',
      httpClient: MockClient((req) async {
        if (req.url.path == '/v1/auth/refresh') {
          refreshCalls += 1;
          return _json(200, {'accessToken': 'fresh', 'refreshToken': 'refresh2', 'expiresIn': 900, 'tokenType': 'Bearer'});
        }
        if (req.headers['authorization'] == 'Bearer stale') return _json(401, {'code': 'unauthorized', 'message': 'expired'});
        return _json(200, {'accepted': true});
      }),
    );
    client.restoreTokens(accessToken: 'stale', refreshToken: 'refresh1');

    await Future.wait([
      client.command('dev1', {'capability': 'onoff', 'action': 'on'}),
      client.command('dev2', {'capability': 'onoff', 'action': 'off'}),
      client.command('dev3', {'capability': 'onoff', 'action': 'toggle'}),
    ]);

    expect(refreshCalls, 1);
  });

  test('persists every rotated refresh token, not just the one from login', () async {
    final persisted = <String>[];
    final client = SupremeClient(
      baseUrl: 'http://hub.local',
      onTokensChanged: (access, refresh) => persisted.add(refresh),
      httpClient: MockClient((req) async {
        if (req.url.path == '/v1/auth/refresh') {
          return _json(200, {'accessToken': 'fresh', 'refreshToken': 'rotated-2', 'expiresIn': 900, 'tokenType': 'Bearer'});
        }
        if (req.headers['authorization'] == 'Bearer stale') return _json(401, {'code': 'unauthorized', 'message': 'expired'});
        return _json(200, {'accepted': true});
      }),
    );
    client.restoreTokens(accessToken: 'stale', refreshToken: 'rotated-1');

    await client.command('dev1', {'capability': 'onoff', 'action': 'on'});

    // The ROTATED token must be captured — persisting only the login-time token would get the
    // session revoked (reuse-detected) the next time the app reads its stale persisted value.
    expect(persisted, ['rotated-2']);
    expect(client.refreshToken, 'rotated-2');
  });

  test('clears the session and reports it as expired when the refresh token is also dead', () async {
    var expired = false;
    final client = SupremeClient(
      baseUrl: 'http://hub.local',
      onSessionExpired: () => expired = true,
      httpClient: MockClient((req) async {
        if (req.url.path == '/v1/auth/refresh') return _json(401, {'code': 'unauthorized', 'message': 'refresh token revoked'});
        return _json(401, {'code': 'unauthorized', 'message': 'token expired'});
      }),
    );
    client.restoreTokens(accessToken: 'stale', refreshToken: 'dead');

    await expectLater(client.command('dev1', {'capability': 'onoff', 'action': 'on'}), throwsA(isA<SupremeApiException>()));
    expect(expired, isTrue);
    expect(client.accessToken, isNull);
  });

  test('an explicit refresh() call also fires onSessionExpired on failure (not just the 401 retry path)', () async {
    var expired = false;
    final client = SupremeClient(
      baseUrl: 'http://hub.local',
      onSessionExpired: () => expired = true,
      httpClient: MockClient((req) async => _json(401, {'code': 'unauthorized', 'message': 'refresh token revoked'})),
    );
    client.restoreTokens(accessToken: 'stale', refreshToken: 'dead');

    await expectLater(client.refresh(), throwsA(isA<SupremeApiException>()));
    expect(expired, isTrue);
  });
}
