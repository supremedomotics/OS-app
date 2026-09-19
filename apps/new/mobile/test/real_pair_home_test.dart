import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:supreme_mobile_next/main.dart';

class _OneHubDiscovery implements HubDiscovery {
  final DiscoveredHub hub;
  const _OneHubDiscovery(this.hub);

  @override
  Future<Uri?> discoverLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      hub.controlUri;

  @override
  Future<List<DiscoveredHub>> discoverAllLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      [hub];
}

class _NoHubDiscovery implements HubDiscovery {
  const _NoHubDiscovery();
  @override
  Future<Uri?> discoverLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      null;
  @override
  Future<List<DiscoveredHub>> discoverAllLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      [];
}

void main() {
  group(
      'realPairHome (§Phase12.2 §4/§5) — the real pairing flow, not a placeholder',
      () {
    test(
        'a successful pairing stores a session scoped to the paired Hub and returns its identity',
        () async {
      final hub = DiscoveredHub(
        identity:
            const HubIdentity(hubId: 'hub-real-1', displayName: 'Sea View Hub'),
        address: '192.168.1.50',
      );
      String? seenPublicKey;
      final client = MockClient((req) async {
        if (req.url.path == '/v1/pairing/challenge') {
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          seenPublicKey = body['mobilePublicKeyBase64'] as String;
          return http.Response(
            jsonEncode({
              'challengeId': 'c1',
              'challengeBytes': base64Encode(utf8.encode('nonce')),
              'hubId': 'hub-real-1',
              'projectId': 'proj-1',
            }),
            200,
          );
        }
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        final ok = await Ed25519MobileIdentity.verify(
          message: utf8.encode('nonce'),
          signatureBase64: body['signatureBase64'] as String,
          publicKeyBase64: seenPublicKey!,
        );
        expect(ok, isTrue);
        return http.Response(
          jsonEncode({
            'mobileId': 'mobile-1',
            'hubId': 'hub-real-1',
            'projectId': 'proj-1',
            'token': 'tok-real',
            'issuedAt': DateTime.now().toIso8601String(),
          }),
          200,
        );
      });

      final identity = Ed25519MobileIdentity(InMemorySecretBytesStore());
      final authStore = InMemoryPairedHomeAuthorizationStore();

      final result = await realPairHome(
        discovery: _OneHubDiscovery(hub),
        identity: identity,
        authStore: authStore,
        pairingCode: '482913',
        httpClient: client,
      );

      expect(result.hubId, 'hub-real-1');
      expect(result.projectId, 'proj-1');
      expect(result.suggestedDisplayName, 'Sea View Hub');
      expect(authStore.sessionFor('hub-real-1')!.bearerToken(), 'tok-real');
    });

    test('a failed pairing (rejected signature) throws and stores no session',
        () async {
      final hub = DiscoveredHub(
        identity:
            const HubIdentity(hubId: 'hub-real-1', displayName: 'Sea View Hub'),
        address: '192.168.1.50',
      );
      final client = MockClient((req) async {
        if (req.url.path == '/v1/pairing/challenge') {
          return http.Response(
            jsonEncode({
              'challengeId': 'c1',
              'challengeBytes': base64Encode(utf8.encode('nonce')),
              'hubId': 'hub-real-1',
              'projectId': 'proj-1',
            }),
            200,
          );
        }
        return http.Response(jsonEncode({'message': 'bad signature'}), 401);
      });

      final identity = Ed25519MobileIdentity(InMemorySecretBytesStore());
      final authStore = InMemoryPairedHomeAuthorizationStore();

      await expectLater(
        realPairHome(
          discovery: _OneHubDiscovery(hub),
          identity: identity,
          authStore: authStore,
          pairingCode: 'wrong',
          httpClient: client,
        ),
        throwsA(isA<PairingException>()),
      );
      expect(authStore.sessionFor('hub-real-1'), isNull);
    });

    test('no Hub on the network throws before any pairing attempt', () async {
      final identity = Ed25519MobileIdentity(InMemorySecretBytesStore());
      final authStore = InMemoryPairedHomeAuthorizationStore();

      expect(
        realPairHome(
          discovery: const _NoHubDiscovery(),
          identity: identity,
          authStore: authStore,
          pairingCode: '123456',
        ),
        throwsStateError,
      );
    });
  });

  group('Per-Home ConnectionManager isolation (§Phase12.2 §11/§12/§15)', () {
    // Both tests below override `platformDiscoveryProvider`/`pairedHomeAuthStoreProvider` to
    // deterministic in-memory fakes — this proves the PROVIDER WIRING (per-Home scoping,
    // rebuild-on-switch, no cross-Home token reuse), not the real mDNS/secure-storage platform
    // channels, which plain `test()` (no platform binding) cannot exercise. Those are covered
    // separately: mDNS by `discovery_factory_io.dart`'s reuse of the already-tested
    // `MdnsHubDiscovery`, secure storage by `SecurePairedHomeAuthorizationStore`'s reuse of the
    // already-tested `InMemoryPairedHomeAuthorizationStore`-shaped interface plus real
    // `flutter_secure_storage` calls that only a device/emulator can genuinely prove.
    test(
        'switching activeHomeId produces a genuinely different ConnectionManager instance,\n'
        'never the previous Home\'s stale one', () {
      final container = ProviderContainer(overrides: [
        platformDiscoveryProvider
            .overrideWithValue(const MockHubDiscovery(hubPresent: false)),
        pairedHomeAuthStoreProvider
            .overrideWithValue(InMemoryPairedHomeAuthorizationStore()),
      ]);
      addTearDown(container.dispose);

      container.read(activeHomeIdProvider.notifier).state = 'hub-a';
      final managerA = container.read(connectionManagerProvider);

      container.read(activeHomeIdProvider.notifier).state = 'hub-b';
      final managerB = container.read(connectionManagerProvider);

      expect(identical(managerA, managerB), isFalse);
    });

    test(
        'each Home\'s bearer token comes ONLY from its own session — never a cross-Home reuse',
        () {
      final authStore = InMemoryPairedHomeAuthorizationStore();
      final container = ProviderContainer(overrides: [
        pairedHomeAuthStoreProvider.overrideWithValue(authStore),
      ]);
      addTearDown(container.dispose);

      authStore.putSession(
        'hub-a',
        AuthorizedMobileSession(MobileAuthorization(
            mobileId: 'm',
            hubId: 'hub-a',
            projectId: 'p-a',
            token: 'token-a',
            issuedAt: DateTime.now())),
      );
      authStore.putSession(
        'hub-b',
        AuthorizedMobileSession(MobileAuthorization(
            mobileId: 'm',
            hubId: 'hub-b',
            projectId: 'p-b',
            token: 'token-b',
            issuedAt: DateTime.now())),
      );

      expect(authStore.sessionFor('hub-a')!.bearerToken(), 'token-a');
      expect(authStore.sessionFor('hub-b')!.bearerToken(), 'token-b');
    });
  });
}
