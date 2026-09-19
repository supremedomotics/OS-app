import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

HomeEvent _event({
  required String eventId,
  required String hubId,
  HomeEventType type = HomeEventType.doorphoneRing,
}) =>
    HomeEvent(
      eventId: eventId,
      hubId: hubId,
      projectId: 'proj-$hubId',
      type: type,
      occurredAt: DateTime.now(),
    );

void main() {
  group('MobileRuntime — multi-Home event isolation (§Phase12.5 §3/§19 B/C/D)',
      () {
    test('an event for an authorized Home is surfaced', () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']);
      expect(
          runtime.ingestEvent(_event(eventId: 'e1', hubId: 'hub-a')), isTrue);
    });

    test(
        'an event for a Home this Mobile is NOT authorized for is dropped, never surfaced',
        () async {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']);
      final seen = <HomeEvent>[];
      runtime.events.listen(seen.add);

      final accepted =
          runtime.ingestEvent(_event(eventId: 'e1', hubId: 'hub-unauthorized'));

      expect(accepted, isFalse);
      await Future.delayed(Duration.zero);
      expect(seen, isEmpty);
    });

    test(
        'events from Home A and Home B are both surfaced independently, never merged',
        () async {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a', 'hub-b']);
      final seen = <HomeEvent>[];
      runtime.events.listen(seen.add);

      runtime.ingestEvent(_event(eventId: 'e1', hubId: 'hub-a'));
      runtime.ingestEvent(_event(
          eventId: 'e1', hubId: 'hub-b')); // same raw eventId, different Home

      await Future.delayed(Duration.zero);
      expect(seen, hasLength(2));
      expect(seen.map((e) => e.hubId).toSet(), {'hub-a', 'hub-b'});
    });

    test(
        'revoking authorization for a Home stops its events from being surfaced',
        () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']);
      expect(
          runtime.ingestEvent(_event(eventId: 'e1', hubId: 'hub-a')), isTrue);

      runtime.updateAuthorizedHomes([]); // Home A removed/revoked
      expect(
          runtime.ingestEvent(_event(eventId: 'e2', hubId: 'hub-a')), isFalse);
    });
  });

  group('Event deduplication (§Phase12.5 §13/§19 E/M)', () {
    test('the identical (hubId, eventId) is only surfaced once', () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']);

      expect(
          runtime.ingestEvent(_event(eventId: 'e1', hubId: 'hub-a')), isTrue);
      expect(runtime.ingestEvent(_event(eventId: 'e1', hubId: 'hub-a')),
          isFalse); // duplicate/retry
    });

    test(
        'the SAME raw eventId from two different Hubs never collides (dedup key includes hubId)',
        () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a', 'hub-b']);

      expect(runtime.ingestEvent(_event(eventId: 'shared-id', hubId: 'hub-a')),
          isTrue);
      expect(runtime.ingestEvent(_event(eventId: 'shared-id', hubId: 'hub-b')),
          isTrue);
    });

    test('SeenEventTracker evicts the oldest entry once capacity is exceeded',
        () {
      final tracker = SeenEventTracker(capacity: 2);
      expect(tracker.markIfNew(_event(eventId: 'e1', hubId: 'hub-a')), isTrue);
      expect(tracker.markIfNew(_event(eventId: 'e2', hubId: 'hub-a')), isTrue);
      expect(tracker.markIfNew(_event(eventId: 'e3', hubId: 'hub-a')),
          isTrue); // evicts e1
      expect(tracker.hasSeen(_event(eventId: 'e1', hubId: 'hub-a')), isFalse);
      expect(tracker.hasSeen(_event(eventId: 'e3', hubId: 'hub-a')), isTrue);
    });
  });

  group('Malformed/unsupported events (§Phase12.5 §14/§19 N/O)', () {
    test(
        'an event of a supported type but for an unauthorized Home is simply dropped, never throws',
        () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes([]);
      expect(() => runtime.ingestEvent(_event(eventId: 'e1', hubId: 'hub-a')),
          returnsNormally);
    });
  });

  group('Doorphone call state machine (§Phase12.5 §4/§19 P/Q/R/S)', () {
    CallSession newCall(String hubId) => CallSession(
          callId: 'call-1',
          hubId: hubId,
          projectId: 'proj-$hubId',
          media: CallMedia.video,
          state: CallState.incoming,
          startedAt: DateTime.now(),
        );

    test('an incoming call for an authorized Home is surfaced', () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']);
      expect(runtime.ingestIncomingCall(newCall('hub-a')), isTrue);
      expect(runtime.activeCall('call-1')!.state, CallState.incoming);
    });

    test('an incoming call for an unauthorized Home is dropped', () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']);
      expect(runtime.ingestIncomingCall(newCall('hub-b')), isFalse);
      expect(runtime.activeCall('call-1'), isNull);
    });

    test('acceptance path: incoming -> ringing -> connecting -> connected', () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']);
      runtime.ingestIncomingCall(newCall('hub-a'));

      runtime.transitionCall('call-1', CallState.ringing);
      runtime.transitionCall('call-1', CallState.connecting);
      final connected = runtime.transitionCall('call-1', CallState.connected);

      expect(connected.state, CallState.connected);
    });

    test('rejection path: incoming -> ended, and the call is cleaned up', () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']);
      runtime.ingestIncomingCall(newCall('hub-a'));

      runtime.transitionCall('call-1', CallState.ended);

      expect(runtime.activeCall('call-1'), isNull); // session cleanup (§19 T)
    });

    test('termination path: connected -> ending -> ended', () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']);
      runtime.ingestIncomingCall(newCall('hub-a'));
      runtime.transitionCall('call-1', CallState.ringing);
      runtime.transitionCall('call-1', CallState.connecting);
      runtime.transitionCall('call-1', CallState.connected);

      runtime.transitionCall('call-1', CallState.ending);
      runtime.transitionCall('call-1', CallState.ended);

      expect(runtime.activeCall('call-1'), isNull);
    });

    test(
        'an illegal transition (ended -> connected) throws rather than silently succeeding',
        () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']);
      runtime.ingestIncomingCall(newCall('hub-a'));
      runtime.transitionCall('call-1', CallState.ended);

      expect(() => runtime.transitionCall('call-1', CallState.connected),
          throwsStateError);
    });

    test('transitioning an unknown call id throws', () {
      final runtime = MobileRuntime();
      expect(() => runtime.transitionCall('nonexistent', CallState.ringing),
          throwsStateError);
    });

    test(
        'two Homes\' calls remain independent — ending Home A\'s call never touches Home B\'s',
        () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a', 'hub-b']);
      runtime.ingestIncomingCall(newCall('hub-a'));
      runtime.ingestIncomingCall(CallSession(
        callId: 'call-2',
        hubId: 'hub-b',
        projectId: 'proj-hub-b',
        media: CallMedia.voice,
        state: CallState.incoming,
        startedAt: DateTime.now(),
      ));

      runtime.transitionCall('call-1', CallState.ended);

      expect(runtime.activeCall('call-1'), isNull);
      expect(runtime.activeCall('call-2')!.state, CallState.incoming);
    });
  });
}
