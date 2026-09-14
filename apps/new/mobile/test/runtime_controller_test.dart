import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:supreme_mobile_next/features/settings/paired_home_controller.dart';
import 'package:supreme_mobile_next/runtime/runtime_controller.dart';

class _FakePushTokenSource implements PlatformPushTokenSource {
  final String _token;
  _FakePushTokenSource(this._token);
  @override
  Future<String?> currentToken() async => _token;
  @override
  Stream<String> get onTokenRefresh => const Stream.empty();
  @override
  String get platform => 'fcm';
}

void main() {
  group('RuntimeController (§Phase12.5) — authorized-Home sync and isolation',
      () {
    test(
        'the runtime\'s authorized Homes stay in sync with PairedHomeController',
        () async {
      final store = InMemoryPairedHomeStore();
      final homeController = PairedHomeController(store);
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');

      final runtime = MobileRuntime();
      final controller = RuntimeController(
        homeController: homeController,
        authStore: InMemoryPairedHomeAuthorizationStore(),
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async => null,
        resolveHomeStreamUri: (_) async => null,
        runtime: runtime,
      );

      expect(runtime.isAuthorizedForHub('hub-a'), isTrue);
      expect(runtime.isAuthorizedForHub('hub-b'), isFalse);

      await homeController.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'B');
      expect(runtime.isAuthorizedForHub('hub-b'), isTrue);

      await homeController.removeHome('hub-a');
      expect(runtime.isAuthorizedForHub('hub-a'), isFalse);
      expect(runtime.isAuthorizedForHub('hub-b'),
          isTrue); // unaffected by A's removal

      controller.dispose();
    });

    test('ingestHomeEvent routes through the runtime\'s isolation/dedup logic',
        () async {
      final store = InMemoryPairedHomeStore();
      final homeController = PairedHomeController(store);
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');

      final controller = RuntimeController(
        homeController: homeController,
        authStore: InMemoryPairedHomeAuthorizationStore(),
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async => null,
        resolveHomeStreamUri: (_) async => null,
      );

      final event = HomeEvent(
        eventId: 'e1',
        hubId: 'hub-a',
        projectId: 'proj-a',
        type: HomeEventType.doorphoneRing,
        occurredAt: DateTime.now(),
      );

      expect(controller.ingestHomeEvent(event), isTrue);
      expect(controller.ingestHomeEvent(event), isFalse); // duplicate

      controller.dispose();
    });

    test(
        'registerPushTokenForAllHomes is a documented no-op without a push token source',
        () async {
      final store = InMemoryPairedHomeStore();
      final homeController = PairedHomeController(store);
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');

      final controller = RuntimeController(
        homeController: homeController,
        authStore: InMemoryPairedHomeAuthorizationStore(),
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async => null,
        resolveHomeStreamUri: (_) async => null,
      );

      await expectLater(controller.registerPushTokenForAllHomes(), completes);
      controller.dispose();
    });

    test(
        'registerPushTokenForAllHomes skips a Home with no live session, never fabricating one',
        () async {
      final store = InMemoryPairedHomeStore();
      final homeController = PairedHomeController(store);
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');

      var resolveCalls = 0;
      final controller = RuntimeController(
        homeController: homeController,
        authStore:
            InMemoryPairedHomeAuthorizationStore(), // no session for hub-a
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async {
          resolveCalls++;
          return Uri.parse('https://192.168.1.50');
        },
        resolveHomeStreamUri: (_) async => null,
        pushTokenSource: _FakePushTokenSource('device-token'),
      );

      await controller.registerPushTokenForAllHomes();

      expect(resolveCalls,
          0); // never even asked for a URL — no session to authenticate with
      controller.dispose();
    });
  });
}
