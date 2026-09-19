import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:supreme_mobile_next/features/settings/paired_home_controller.dart';
import 'package:supreme_mobile_next/runtime/runtime_controller.dart';

class _FakeTransport implements EventStreamTransport {
  int connectCalls = 0;
  bool disposed = false;
  @override
  Stream<HubEventStreamState> get state => const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get frames => const Stream.empty();
  @override
  Future<void> connect() async {
    connectCalls++;
  }

  @override
  Future<void> disconnect() async {}
  @override
  void send(Map<String, dynamic> frame) {}
  @override
  Future<void> dispose() async {
    disposed = true;
  }
}

void main() {
  group('RuntimeController.startEventStreamsForAllHomes (§Phase12.7)', () {
    test('skips a Home with no live session, never opening a transport for it',
        () async {
      final store = InMemoryPairedHomeStore();
      final homeController = PairedHomeController(store);
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');

      final controller = RuntimeController(
        homeController: homeController,
        authStore:
            InMemoryPairedHomeAuthorizationStore(), // no session for hub-a
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async => Uri.parse('https://192.168.1.50'),
        resolveHomeStreamUri: (_) async => Uri.parse('wss://192.168.1.50/v1/stream'),
      );

      final transports = <_FakeTransport>[];
      await controller.startEventStreamsForAllHomes(
        buildTransport: (hubId, baseUrl, bearerToken) {
          final t = _FakeTransport();
          transports.add(t);
          return t;
        },
        onSnapshotRequired: (_) async {},
      );

      expect(transports, isEmpty);
      controller.dispose();
    });

    test('opens exactly one transport per authorized Home with a live session',
        () async {
      final store = InMemoryPairedHomeStore();
      final homeController = PairedHomeController(store);
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await homeController.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'B');

      final authStore = InMemoryPairedHomeAuthorizationStore();
      for (final hubId in ['hub-a', 'hub-b']) {
        authStore.putSession(
          hubId,
          AuthorizedMobileSession(MobileAuthorization(
              mobileId: 'm',
              hubId: hubId,
              projectId: 'proj-$hubId',
              token: 'tok-$hubId',
              issuedAt: DateTime.now())),
        );
      }

      final controller = RuntimeController(
        homeController: homeController,
        authStore: authStore,
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async => Uri.parse('https://192.168.1.50'),
        resolveHomeStreamUri: (_) async => Uri.parse('wss://192.168.1.50/v1/stream'),
      );

      final transports = <_FakeTransport>[];
      await controller.startEventStreamsForAllHomes(
        buildTransport: (hubId, baseUrl, bearerToken) {
          final t = _FakeTransport();
          transports.add(t);
          return t;
        },
        onSnapshotRequired: (_) async {},
      );

      expect(transports, hasLength(2));
      expect(transports.every((t) => t.connectCalls == 1), isTrue);
      controller.dispose();
    });

    test(
        'calling startEventStreamsForAllHomes twice never opens a duplicate stream for the same Home',
        () async {
      final store = InMemoryPairedHomeStore();
      final homeController = PairedHomeController(store);
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');

      final authStore = InMemoryPairedHomeAuthorizationStore();
      authStore.putSession(
        'hub-a',
        AuthorizedMobileSession(MobileAuthorization(
            mobileId: 'm',
            hubId: 'hub-a',
            projectId: 'proj-a',
            token: 'tok',
            issuedAt: DateTime.now())),
      );

      final controller = RuntimeController(
        homeController: homeController,
        authStore: authStore,
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async => Uri.parse('https://192.168.1.50'),
        resolveHomeStreamUri: (_) async => Uri.parse('wss://192.168.1.50/v1/stream'),
      );

      final transports = <_FakeTransport>[];
      Future<void> start() => controller.startEventStreamsForAllHomes(
            buildTransport: (hubId, baseUrl, bearerToken) {
              final t = _FakeTransport();
              transports.add(t);
              return t;
            },
            onSnapshotRequired: (_) async {},
          );

      await start();
      await start();

      expect(transports, hasLength(1)); // second call opened nothing new
      controller.dispose();
    });

    test('removing a paired Home disposes its event-stream transport',
        () async {
      final store = InMemoryPairedHomeStore();
      final homeController = PairedHomeController(store);
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');

      final authStore = InMemoryPairedHomeAuthorizationStore();
      authStore.putSession(
        'hub-a',
        AuthorizedMobileSession(MobileAuthorization(
            mobileId: 'm',
            hubId: 'hub-a',
            projectId: 'proj-a',
            token: 'tok',
            issuedAt: DateTime.now())),
      );

      final controller = RuntimeController(
        homeController: homeController,
        authStore: authStore,
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async => Uri.parse('https://192.168.1.50'),
        resolveHomeStreamUri: (_) async => Uri.parse('wss://192.168.1.50/v1/stream'),
      );

      final transports = <_FakeTransport>[];
      await controller.startEventStreamsForAllHomes(
        buildTransport: (hubId, baseUrl, bearerToken) {
          final t = _FakeTransport();
          transports.add(t);
          return t;
        },
        onSnapshotRequired: (_) async {},
      );

      await homeController.removeHome('hub-a');
      await Future.delayed(Duration.zero);

      expect(transports.single.disposed, isTrue);
      controller.dispose();
    });
  });

  group(
      'resolveHomeStreamUri decides local vs remote — the ONE decision point (§Phase12.10 §4/§5)',
      () {
    test(
        'a Home resolveHomeStreamUri returns null for (LAN unreachable, Remote Access off) opens no transport',
        () async {
      final store = InMemoryPairedHomeStore();
      final homeController = PairedHomeController(store);
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');

      final authStore = InMemoryPairedHomeAuthorizationStore();
      authStore.putSession(
        'hub-a',
        AuthorizedMobileSession(MobileAuthorization(
            mobileId: 'm',
            hubId: 'hub-a',
            projectId: 'proj-a',
            token: 'tok',
            issuedAt: DateTime.now())),
      );

      final controller = RuntimeController(
        homeController: homeController,
        authStore: authStore,
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async => null,
        // Simulates the real composition root's own resolver: LAN unreachable AND this Home's
        // Remote Access switch is off — never a silent fallback.
        resolveHomeStreamUri: (_) async => null,
      );

      final transports = <_FakeTransport>[];
      await controller.startEventStreamsForAllHomes(
        buildTransport: (hubId, streamUri, bearerToken) {
          final t = _FakeTransport();
          transports.add(t);
          return t;
        },
        onSnapshotRequired: (_) async {},
      );

      expect(transports, isEmpty);
      controller.dispose();
    });

    test(
        'a Home with LAN unreachable but Remote Access on connects via the remote streamUri',
        () async {
      final store = InMemoryPairedHomeStore();
      final homeController = PairedHomeController(store);
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await homeController.setRemoteAccessEnabled('hub-a', true);

      final authStore = InMemoryPairedHomeAuthorizationStore();
      authStore.putSession(
        'hub-a',
        AuthorizedMobileSession(MobileAuthorization(
            mobileId: 'm',
            hubId: 'hub-a',
            projectId: 'proj-a',
            token: 'tok',
            issuedAt: DateTime.now())),
      );

      final remoteStreamUri =
          Uri.parse('wss://broker.example.com/v1/route/hub-a/stream');
      final controller = RuntimeController(
        homeController: homeController,
        authStore: authStore,
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async => null, // LAN unreachable
        resolveHomeStreamUri: (hubId) async =>
            homeController.homes
                    .firstWhere((h) => h.hubId == hubId)
                    .remoteAccessEnabled
                ? remoteStreamUri
                : null,
      );

      Uri? seenUri;
      final transports = <_FakeTransport>[];
      await controller.startEventStreamsForAllHomes(
        buildTransport: (hubId, streamUri, bearerToken) {
          seenUri = streamUri;
          final t = _FakeTransport();
          transports.add(t);
          return t;
        },
        onSnapshotRequired: (_) async {},
      );

      expect(transports, hasLength(1));
      expect(seenUri, remoteStreamUri);
      controller.dispose();
    });
  });
}
