import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// A fake [PairingTransport] standing in for the real Hub endpoint that
/// does not exist yet (§Phase11 SERVER-SIDE REQUIRED) — but it enforces the
/// SAME contract a real Hub must: reject the wrong pairing code, reject a
/// bad signature, reject a Mobile identity it has revoked. This proves
/// [PairingClient] drives a real challenge/response flow, not a shortcut.
class FakeHubPairingTransport implements PairingTransport {
  final String correctCode;
  final String hubId;
  final String projectId;
  final Set<String> revokedPublicKeys;
  String? _issuedChallengeId;
  List<int>? _challengeBytes;
  String? _pendingPublicKey;

  FakeHubPairingTransport({
    required this.correctCode,
    this.hubId = 'hub-abc',
    this.projectId = 'project-1',
    Set<String>? revokedPublicKeys,
  }) : revokedPublicKeys = revokedPublicKeys ?? {};

  @override
  Future<PairingChallengeResponse> requestChallenge(
      {required String pairingCode,
      required String mobilePublicKeyBase64}) async {
    if (pairingCode != correctCode) {
      throw const PairingException('invalid or expired pairing code');
    }
    if (revokedPublicKeys.contains(mobilePublicKeyBase64)) {
      throw const PairingException('this Mobile identity has been revoked');
    }
    _issuedChallengeId = 'challenge-1';
    _challengeBytes =
        'nonce-${DateTime.now().microsecondsSinceEpoch}'.codeUnits;
    _pendingPublicKey = mobilePublicKeyBase64;
    return PairingChallengeResponse(
      challengeId: _issuedChallengeId!,
      challengeBytes: _challengeBytes!,
      hubId: hubId,
      projectId: projectId,
    );
  }

  @override
  Future<MobileAuthorization> submitSignedChallenge(
      {required String challengeId, required String signatureBase64}) async {
    if (challengeId != _issuedChallengeId) {
      throw const PairingException('unknown or expired challenge');
    }
    final valid = await Ed25519MobileIdentity.verify(
      message: _challengeBytes!,
      signatureBase64: signatureBase64,
      publicKeyBase64: _pendingPublicKey!,
    );
    if (!valid) {
      throw const PairingException('signature does not match challenge');
    }
    return MobileAuthorization(
      mobileId: 'mobile-1',
      hubId: hubId,
      projectId: projectId,
      token: 'session-token-xyz',
      issuedAt: DateTime.now(),
    );
  }
}

void main() {
  group('PairingClient — real challenge/response, never MAC-based (§Phase11-8)',
      () {
    test('a correct pairing code + real signature yields a valid authorization',
        () async {
      final identity = Ed25519MobileIdentity(InMemorySecretBytesStore());
      final transport = FakeHubPairingTransport(correctCode: '482913');
      final client = PairingClient(identity: identity, transport: transport);

      final authorization = await client.pairUsingCode('482913');

      expect(authorization.hubId, 'hub-abc');
      expect(authorization.projectId, 'project-1');
      expect(authorization.token, isNotEmpty);
    });

    test('a wrong pairing code is rejected, not silently authorized', () async {
      final identity = Ed25519MobileIdentity(InMemorySecretBytesStore());
      final transport = FakeHubPairingTransport(correctCode: '482913');
      final client = PairingClient(identity: identity, transport: transport);

      expect(client.pairUsingCode('000000'), throwsA(isA<PairingException>()));
    });

    test('a revoked Mobile public key cannot pair, even with the correct code',
        () async {
      final identity = Ed25519MobileIdentity(InMemorySecretBytesStore());
      final mobile = await identity.generateAndPersist();
      final transport = FakeHubPairingTransport(
        correctCode: '482913',
        revokedPublicKeys: {mobile.publicKeyBase64},
      );
      final client = PairingClient(identity: identity, transport: transport);

      expect(client.pairUsingCode('482913'), throwsA(isA<PairingException>()));
    });
  });

  group('AuthorizedMobileSession — revocation and expiry stop token use', () {
    MobileAuthorization authorizationExpiringAt(DateTime? expiresAt) =>
        MobileAuthorization(
          mobileId: 'mobile-1',
          hubId: 'hub-abc',
          projectId: 'project-1',
          token: 'tok',
          issuedAt: DateTime.now(),
          expiresAt: expiresAt,
        );

    test('bearerToken() returns the real token while valid', () {
      final session = AuthorizedMobileSession(authorizationExpiringAt(null));
      expect(session.bearerToken(), 'tok');
    });

    test(
        'markRevoked() makes bearerToken() throw instead of returning a stale token',
        () {
      final session = AuthorizedMobileSession(authorizationExpiringAt(null));
      session.markRevoked();
      expect(() => session.bearerToken(), throwsA(isA<PairingException>()));
    });

    test('an expired authorization also stops token use', () {
      final session = AuthorizedMobileSession(authorizationExpiringAt(
          DateTime.now().subtract(const Duration(minutes: 1))));
      expect(() => session.bearerToken(), throwsA(isA<PairingException>()));
    });
  });
}
