import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

void main() {
  group(
      'PairedHomeAuthorizationStore — per-Home isolation (§Phase12.2 §9/§10/§31)',
      () {
    AuthorizedMobileSession sessionFor(String hubId) => AuthorizedMobileSession(
          MobileAuthorization(
            mobileId: 'mobile-1',
            hubId: hubId,
            projectId: 'proj-$hubId',
            token: 'token-for-$hubId',
            issuedAt: DateTime.now(),
          ),
        );

    test('a session stored for Home A is never returned when looking up Home B',
        () {
      final store = InMemoryPairedHomeAuthorizationStore();
      store.putSession('hub-a', sessionFor('hub-a'));
      store.putSession('hub-b', sessionFor('hub-b'));

      expect(store.sessionFor('hub-a')!.authorization.token, 'token-for-hub-a');
      expect(store.sessionFor('hub-b')!.authorization.token, 'token-for-hub-b');
      expect(store.sessionFor('hub-a')!.authorization.token,
          isNot(store.sessionFor('hub-b')!.authorization.token));
    });

    test(
        'an unknown hubId returns no session — never a fallback to another Home\'s',
        () {
      final store = InMemoryPairedHomeAuthorizationStore();
      store.putSession('hub-a', sessionFor('hub-a'));
      expect(store.sessionFor('hub-b'), isNull);
    });

    test('clearing Home A\'s session leaves Home B untouched', () {
      final store = InMemoryPairedHomeAuthorizationStore();
      store.putSession('hub-a', sessionFor('hub-a'));
      store.putSession('hub-b', sessionFor('hub-b'));

      store.clearSession('hub-a');

      expect(store.sessionFor('hub-a'), isNull);
      expect(store.sessionFor('hub-b'), isNotNull);
    });

    test('revoking (marking revoked) Home A\'s session never revokes Home B\'s',
        () {
      final store = InMemoryPairedHomeAuthorizationStore();
      final sessionA = sessionFor('hub-a');
      final sessionB = sessionFor('hub-b');
      store.putSession('hub-a', sessionA);
      store.putSession('hub-b', sessionB);

      sessionA.markRevoked();

      expect(() => store.sessionFor('hub-a')!.bearerToken(),
          throwsA(isA<PairingException>()));
      expect(store.sessionFor('hub-b')!.bearerToken(), 'token-for-hub-b');
    });
  });
}
