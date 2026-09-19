import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

void main() {
  group('Ed25519MobileIdentity — real cryptography, not a stand-in', () {
    test(
        'generateAndPersist produces a real keypair that round-trips through load()',
        () async {
      final store = InMemorySecretBytesStore();
      final identity =
          Ed25519MobileIdentity(store, idGenerator: () => 'mobile-1');

      final generated = await identity.generateAndPersist();
      expect(generated.deviceId, 'mobile-1');
      expect(generated.publicKeyBase64, isNotEmpty);

      final reloaded = await Ed25519MobileIdentity(store).load();
      expect(reloaded, isNotNull);
      expect(reloaded!.publicKeyBase64, generated.publicKeyBase64);
    });

    test(
        'sign() produces a signature that verify() accepts for the real message',
        () async {
      final identity = Ed25519MobileIdentity(InMemorySecretBytesStore());
      final mobile = await identity.generateAndPersist();
      final message = 'pairing-challenge-abc123'.codeUnits;

      final signature = await identity.sign(message);

      final ok = await Ed25519MobileIdentity.verify(
        message: message,
        signatureBase64: signature,
        publicKeyBase64: mobile.publicKeyBase64,
      );
      expect(ok, isTrue);
    });

    test(
        'verify() rejects a tampered message (real cryptography, not string equality)',
        () async {
      final identity = Ed25519MobileIdentity(InMemorySecretBytesStore());
      final mobile = await identity.generateAndPersist();
      final signature = await identity.sign('original'.codeUnits);

      final ok = await Ed25519MobileIdentity.verify(
        message: 'tampered'.codeUnits,
        signatureBase64: signature,
        publicKeyBase64: mobile.publicKeyBase64,
      );
      expect(ok, isFalse);
    });

    test('sign() throws before an identity has been loaded or generated',
        () async {
      final identity = Ed25519MobileIdentity(InMemorySecretBytesStore());
      expect(() => identity.sign('x'.codeUnits), throwsStateError);
    });
  });
}
