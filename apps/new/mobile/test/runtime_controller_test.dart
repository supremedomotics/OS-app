import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:supreme_mobile_next/features/settings/paired_home_controller.dart';
import 'package:supreme_mobile_next/runtime/lifecycle.dart';
import 'package:supreme_mobile_next/runtime/runtime_controller.dart';

class _FakePushTokenSource implements PlatformPushTokenSource {
  final String _token;
  int initializeCallCount = 0;
  bool disposed = false;
  _FakePushTokenSource(this._token);
  @override
  Future<void> initialize() async {
    initializeCallCount++;
  }

  @override
  Future<String?> currentToken() async => _token;
  @override
  Stream<String> get onTokenRefresh => const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onPushReceived => const Stream.empty();
  @override
  String get platform => 'fcm';
  @override
  Future<void> dispose() async {
    disposed = true;
  }
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

  group(
      'process/UI lifecycle tracking (§Phase13.1 §6/§7) — recorded only, never affects connectivity',
      () {
    RuntimeController controllerFor(PairedHomeController homeController) =>
        RuntimeController(
          homeController: homeController,
          authStore: InMemoryPairedHomeAuthorizationStore(),
          pushClient: PushRegistrationClient(),
          resolveHomeBaseUrl: (_) async => null,
          resolveHomeStreamUri: (_) async => null,
        );

    test('starts as ProcessState.starting / UiState.noUi', () async {
      final homeController = PairedHomeController(InMemoryPairedHomeStore());
      await homeController.load();
      final controller = controllerFor(homeController);

      expect(controller.processState, ProcessState.starting);
      expect(controller.uiState, UiState.noUi);
      controller.dispose();
    });

    test('updateProcessState/updateUiState update their getters', () async {
      final homeController = PairedHomeController(InMemoryPairedHomeStore());
      await homeController.load();
      final controller = controllerFor(homeController);

      controller.updateProcessState(ProcessState.background);
      controller.updateUiState(UiState.uiBackgrounded);

      expect(controller.processState, ProcessState.background);
      expect(controller.uiState, UiState.uiBackgrounded);
      controller.dispose();
    });

    test(
        'setting the SAME state again never emits a duplicate lifecycleChanges event (§14)',
        () async {
      final homeController = PairedHomeController(InMemoryPairedHomeStore());
      await homeController.load();
      final controller = controllerFor(homeController);

      final events = <void>[];
      final sub = controller.lifecycleChanges.listen(events.add);

      controller.updateProcessState(ProcessState.foreground);
      await Future<void>.delayed(Duration.zero);
      expect(events, hasLength(1));

      controller.updateProcessState(ProcessState.foreground); // no change
      await Future<void>.delayed(Duration.zero);
      expect(events, hasLength(1)); // no duplicate

      controller.updateUiState(UiState.uiActive);
      await Future<void>.delayed(Duration.zero);
      expect(events, hasLength(2)); // a genuinely different dimension changed

      await sub.cancel();
      controller.dispose();
    });

    test(
        'lifecycle updates never touch event-stream sessions or Home authorization state',
        () async {
      final homeController = PairedHomeController(InMemoryPairedHomeStore());
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      final controller = controllerFor(homeController);

      expect(controller.runtime.isAuthorizedForHub('hub-a'), isTrue);

      controller.updateProcessState(ProcessState.background);
      controller.updateProcessState(ProcessState.suspended);
      controller.updateUiState(UiState.uiBackgrounded);
      controller.updateUiState(UiState.noUi);

      // §7: entering background/no-UI must not change Home connectivity semantics — there is
      // no event-stream session here at all (resolveHomeStreamUri returns null), and Home
      // authorization is completely untouched by any of the lifecycle calls above.
      expect(controller.runtime.isAuthorizedForHub('hub-a'), isTrue);
      controller.dispose();
    });

    test(
        'starts as AndroidServiceState.stopped, and updateAndroidServiceState never touches Home state (§Phase13.3)',
        () async {
      final homeController = PairedHomeController(InMemoryPairedHomeStore());
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      final controller = controllerFor(homeController);

      expect(controller.androidServiceState, AndroidServiceState.stopped);

      final events = <void>[];
      final sub = controller.lifecycleChanges.listen(events.add);

      controller.updateAndroidServiceState(AndroidServiceState.starting);
      controller.updateAndroidServiceState(AndroidServiceState.running);
      controller.updateAndroidServiceState(AndroidServiceState.running); // no change
      await Future<void>.delayed(Duration.zero);

      expect(controller.androidServiceState, AndroidServiceState.running);
      expect(events, hasLength(2)); // starting, running — the redundant repeat never fires again
      expect(controller.runtime.isAuthorizedForHub('hub-a'), isTrue); // untouched

      await sub.cancel();
      controller.dispose();
    });

    test(
        'AndroidServiceState is a genuinely independent dimension from ProcessState/UiState',
        () async {
      final homeController = PairedHomeController(InMemoryPairedHomeStore());
      await homeController.load();
      final controller = controllerFor(homeController);

      controller.updateProcessState(ProcessState.background);
      controller.updateUiState(UiState.uiBackgrounded);
      controller.updateAndroidServiceState(AndroidServiceState.running);

      // All three co-exist independently — exactly the "background, service running,
      // still reachable" scenario the phase's example lifecycle table describes.
      expect(controller.processState, ProcessState.background);
      expect(controller.uiState, UiState.uiBackgrounded);
      expect(controller.androidServiceState, AndroidServiceState.running);
      controller.dispose();
    });
  });

  group('push token lifecycle (§Phase13.2 §2/§3/§4)', () {
    Future<PairedHomeController> twoHomes() async {
      final homeController = PairedHomeController(InMemoryPairedHomeStore());
      await homeController.load();
      await homeController.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await homeController.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'B');
      return homeController;
    }

    InMemoryPairedHomeAuthorizationStore sessionsFor(List<String> hubIds) {
      final store = InMemoryPairedHomeAuthorizationStore();
      for (final hubId in hubIds) {
        store.putSession(
          hubId,
          AuthorizedMobileSession(MobileAuthorization(
              mobileId: 'm',
              hubId: hubId,
              projectId: 'proj-$hubId',
              token: 'tok-$hubId',
              issuedAt: DateTime.now())),
        );
      }
      return store;
    }

    test(
        'registerPushTokenForAllHomes calls initialize() exactly once per registration pass, never per-Home',
        () async {
      final homeController = await twoHomes();
      final source = _FakePushTokenSource('device-token');
      final calls = <String>[];
      final client = MockClient((req) async {
        calls.add(req.url.toString());
        return http.Response('{}', 201);
      });
      final controller = RuntimeController(
        homeController: homeController,
        authStore: sessionsFor(['hub-a', 'hub-b']),
        pushClient: PushRegistrationClient(client: client),
        resolveHomeBaseUrl: (hubId) async => Uri.parse('https://$hubId.example'),
        resolveHomeStreamUri: (_) async => null,
        pushTokenSource: source,
      );

      await controller.registerPushTokenForAllHomes();

      expect(source.initializeCallCount, 1);
      expect(calls, hasLength(2)); // one registration request per authorized Home
      controller.dispose();
    });

    test(
        'each Home\'s registration is authenticated with THAT Home\'s own bearer token, never a shared one',
        () async {
      final homeController = await twoHomes();
      final seenAuth = <String, String?>{};
      final client = MockClient((req) async {
        seenAuth[req.url.host] = req.headers['authorization'];
        return http.Response('{}', 201);
      });
      final controller = RuntimeController(
        homeController: homeController,
        authStore: sessionsFor(['hub-a', 'hub-b']),
        pushClient: PushRegistrationClient(client: client),
        resolveHomeBaseUrl: (hubId) async => Uri.parse('https://$hubId.example'),
        resolveHomeStreamUri: (_) async => null,
        pushTokenSource: _FakePushTokenSource('device-token'),
      );

      await controller.registerPushTokenForAllHomes();

      expect(seenAuth['hub-a.example'], 'Bearer tok-hub-a');
      expect(seenAuth['hub-b.example'], 'Bearer tok-hub-b');
      controller.dispose();
    });

    test(
        'unregisterPushTokenForHome(A) only ever calls Home A\'s address — never Home B\'s (§4 isolation)',
        () async {
      final homeController = await twoHomes();
      final calls = <String>[];
      final client = MockClient((req) async {
        calls.add(req.url.host);
        return http.Response('', 204);
      });
      final controller = RuntimeController(
        homeController: homeController,
        authStore: sessionsFor(['hub-a', 'hub-b']),
        pushClient: PushRegistrationClient(client: client),
        resolveHomeBaseUrl: (hubId) async => Uri.parse('https://$hubId.example'),
        resolveHomeStreamUri: (_) async => null,
        pushTokenSource: _FakePushTokenSource('device-token'),
      );

      await controller.unregisterPushTokenForHome('hub-a');

      expect(calls, ['hub-a.example']);
      expect(calls, isNot(contains('hub-b.example')));
      controller.dispose();
    });

    test(
        'unregisterPushTokenForHome for a Home with no live session is a documented no-op, never guessing an address',
        () async {
      final homeController = await twoHomes();
      var resolveCalls = 0;
      final controller = RuntimeController(
        homeController: homeController,
        authStore: InMemoryPairedHomeAuthorizationStore(), // no sessions at all
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async {
          resolveCalls++;
          return Uri.parse('https://should-not-be-called.example');
        },
        resolveHomeStreamUri: (_) async => null,
        pushTokenSource: _FakePushTokenSource('device-token'),
      );

      await controller.unregisterPushTokenForHome('hub-a');

      expect(resolveCalls, 0);
      controller.dispose();
    });

    test('dispose() disposes the push token source exactly once', () async {
      final homeController = await twoHomes();
      final source = _FakePushTokenSource('device-token');
      final controller = RuntimeController(
        homeController: homeController,
        authStore: InMemoryPairedHomeAuthorizationStore(),
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async => null,
        resolveHomeStreamUri: (_) async => null,
        pushTokenSource: source,
      );

      controller.dispose();
      await Future<void>.delayed(Duration.zero);

      expect(source.disposed, isTrue);
    });

    test(
        'ingestPushPayload routes a valid envelope through the runtime\'s existing dedup/isolation',
        () async {
      final homeController = await twoHomes();
      final controller = RuntimeController(
        homeController: homeController,
        authStore: InMemoryPairedHomeAuthorizationStore(),
        pushClient: PushRegistrationClient(),
        resolveHomeBaseUrl: (_) async => null,
        resolveHomeStreamUri: (_) async => null,
      );

      final accepted =
          controller.ingestPushPayload({'hubId': 'hub-a', 'eventId': 'evt-1'});
      final duplicate =
          controller.ingestPushPayload({'hubId': 'hub-a', 'eventId': 'evt-1'});
      final unauthorized =
          controller.ingestPushPayload({'hubId': 'hub-unknown', 'eventId': 'evt-2'});
      final malformed = controller.ingestPushPayload({'eventId': 'evt-3'});

      expect(accepted, isTrue);
      expect(duplicate, isFalse);
      expect(unauthorized, isFalse);
      expect(malformed, isFalse);
      controller.dispose();
    });
  });

  group('CallKit/VoIP call-lifecycle handoff (§Phase13.4)', () {
    Future<PairedHomeController> homeWith(String hubId) async {
      final homeController = PairedHomeController(InMemoryPairedHomeStore());
      await homeController.load();
      await homeController.addHome(
          hubId: hubId, projectId: 'proj-$hubId', displayName: hubId);
      return homeController;
    }

    RuntimeController controllerFor2(PairedHomeController homeController) =>
        RuntimeController(
          homeController: homeController,
          authStore: InMemoryPairedHomeAuthorizationStore(),
          pushClient: PushRegistrationClient(),
          resolveHomeBaseUrl: (_) async => null,
          resolveHomeStreamUri: (_) async => null,
        );

    test(
        'handleIncomingCall surfaces a real CallSession for an authorized Home',
        () async {
      final homeController = await homeWith('hub-a');
      final controller = controllerFor2(homeController);
      final seen = <CallSession>[];
      controller.runtime.callUpdates.listen(seen.add);

      final accepted =
          controller.handleIncomingCall(hubId: 'hub-a', callId: 'call-1');
      await Future<void>.delayed(Duration.zero);

      expect(accepted, isTrue);
      expect(seen, hasLength(1));
      expect(seen.single.callId, 'call-1');
      expect(seen.single.state, CallState.incoming);
      controller.dispose();
    });

    test(
        'handleIncomingCall for an UNAUTHORIZED/revoked Home is rejected — never surfaced (§"MULTI-HOME")',
        () async {
      final homeController = PairedHomeController(InMemoryPairedHomeStore());
      await homeController.load(); // no Home paired — hub-x is unauthorized
      final controller = controllerFor2(homeController);

      final accepted =
          controller.handleIncomingCall(hubId: 'hub-x', callId: 'call-1');

      expect(accepted, isFalse);
      expect(controller.runtime.activeCall('call-1'), isNull);
      controller.dispose();
    });

    test(
        'handleNativeCallStateChange drives the real legal sequence (incoming -> ringing -> answer/connecting)',
        () async {
      final homeController = await homeWith('hub-a');
      final controller = controllerFor2(homeController);
      controller.handleIncomingCall(hubId: 'hub-a', callId: 'call-1');
      // §"CALL STATE": CallKit's own successful report IS the "ringing" signal — see
      // VoipCallManager.swift's own doc — so this is the real, required intermediate step,
      // never skippable straight to `connecting`.
      controller.handleNativeCallStateChange(
          callId: 'call-1', state: CallState.ringing);

      final ok = controller.handleNativeCallStateChange(
          callId: 'call-1', state: CallState.connecting);

      expect(ok, isTrue);
      expect(controller.runtime.activeCall('call-1')!.state,
          CallState.connecting);
      controller.dispose();
    });

    test(
        'handleNativeCallStateChange for an unknown callId is dropped, never thrown (native-boundary hardening)',
        () async {
      final homeController = await homeWith('hub-a');
      final controller = controllerFor2(homeController);

      final ok = controller.handleNativeCallStateChange(
          callId: 'never-existed', state: CallState.connecting);

      expect(ok, isFalse); // dropped, not a StateError propagating to the caller
      controller.dispose();
    });

    test(
        'an illegal transition (e.g. ended -> connected) is dropped, never thrown',
        () async {
      final homeController = await homeWith('hub-a');
      final controller = controllerFor2(homeController);
      controller.handleIncomingCall(hubId: 'hub-a', callId: 'call-1');
      controller.handleNativeCallStateChange(
          callId: 'call-1', state: CallState.ended);

      final ok = controller.handleNativeCallStateChange(
          callId: 'call-1', state: CallState.connected);

      expect(ok, isFalse);
      controller.dispose();
    });

    test(
        'answering a call (connecting) never issues any HTTP/command call — no pushClient/HTTP capable of side effects',
        () async {
      final homeController = await homeWith('hub-a');
      var httpCalls = 0;
      final client = MockClient((req) async {
        httpCalls++;
        return http.Response('{}', 200);
      });
      final controller = RuntimeController(
        homeController: homeController,
        authStore: InMemoryPairedHomeAuthorizationStore(),
        pushClient: PushRegistrationClient(client: client),
        resolveHomeBaseUrl: (_) async => null,
        resolveHomeStreamUri: (_) async => null,
      );
      controller.handleIncomingCall(hubId: 'hub-a', callId: 'call-1');

      controller.handleNativeCallStateChange(
          callId: 'call-1', state: CallState.ringing);
      controller.handleNativeCallStateChange(
          callId: 'call-1', state: CallState.connecting);
      controller.handleNativeCallStateChange(
          callId: 'call-1', state: CallState.connected);
      controller.handleNativeCallStateChange(
          callId: 'call-1', state: CallState.ending);
      controller.handleNativeCallStateChange(
          callId: 'call-1', state: CallState.ended);

      // §"ANSWERING A CALL": answering/ending a call never triggers a door-release or any other
      // authenticated command — this class has no transport path that call-state changes touch.
      expect(httpCalls, 0);
      controller.dispose();
    });

    test(
        'duplicate incoming-call reports for the SAME callId never crash and reflect the latest report',
        () async {
      final homeController = await homeWith('hub-a');
      final controller = controllerFor2(homeController);

      expect(controller.handleIncomingCall(hubId: 'hub-a', callId: 'call-1'),
          isTrue);
      // A duplicate PushKit delivery (real-world occurrence — Apple does not guarantee
      // exactly-once VoIP push delivery) reporting the SAME call again.
      expect(controller.handleIncomingCall(hubId: 'hub-a', callId: 'call-1'),
          isTrue);

      expect(controller.runtime.activeCall('call-1')!.state,
          CallState.incoming);
      controller.dispose();
    });

    test('dispose() is safe with active calls pending', () async {
      final homeController = await homeWith('hub-a');
      final controller = controllerFor2(homeController);
      controller.handleIncomingCall(hubId: 'hub-a', callId: 'call-1');

      expect(() => controller.dispose(), returnsNormally);
    });
  });
}
