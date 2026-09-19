import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

void main() {
  group('mapPushEnvelopeToHomeEvent (§Phase13.2 §7/§12)', () {
    test('parses a real, complete envelope into a HomeEvent', () {
      final event = mapPushEnvelopeToHomeEvent({
        'v': '1',
        'hubId': 'hub-a',
        'eventId': 'evt-123',
        'ts': '2026-01-01T00:00:00.000Z',
        'level': 'warning',
        'notificationId': 'evt-123',
      });

      expect(event, isNotNull);
      expect(event!.hubId, 'hub-a');
      expect(event.eventId, 'evt-123');
      expect(event.severity, HomeEventSeverity.warning);
      expect(event.dedupKey, 'hub-a:evt-123');
    });

    test('drops a payload missing hubId — never throws (§12 "unknown push event")', () {
      expect(mapPushEnvelopeToHomeEvent({'eventId': 'e1'}), isNull);
    });

    test('drops a payload missing eventId', () {
      expect(mapPushEnvelopeToHomeEvent({'hubId': 'hub-a'}), isNull);
    });

    test('drops a completely empty/malformed payload', () {
      expect(mapPushEnvelopeToHomeEvent(const {}), isNull);
    });

    test('defaults severity to info for an unrecognized/missing level', () {
      final event = mapPushEnvelopeToHomeEvent({'hubId': 'hub-a', 'eventId': 'e1'});
      expect(event!.severity, HomeEventSeverity.info);
    });

    test('never fabricates a projectId from the payload', () {
      final event = mapPushEnvelopeToHomeEvent(
          {'hubId': 'hub-a', 'eventId': 'e1', 'projectId': 'should-be-ignored'});
      expect(event!.projectId, ''); // real callers resolve this via PairedHomeController
    });
  });

  group(
      'push + WebSocket events share ONE dedup mechanism via MobileRuntime (§Phase13.2 §8)',
      () {
    test('the same (hubId, eventId) delivered via push twice is only processed once', () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']);
      final payload = {'hubId': 'hub-a', 'eventId': 'evt-1'};

      final event1 = mapPushEnvelopeToHomeEvent(payload)!;
      final event2 = mapPushEnvelopeToHomeEvent(payload)!;

      expect(runtime.ingestEvent(event1), isTrue); // first delivery — new
      expect(runtime.ingestEvent(event2), isFalse); // duplicate push retry — suppressed
    });

    test(
        'an event already delivered over the (simulated) WebSocket path is suppressed when the SAME id later arrives via push',
        () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']);

      // Simulates a live /v1/stream-derived HomeEvent with the same (hubId, eventId).
      final wsEvent = HomeEvent(
        eventId: 'evt-1',
        hubId: 'hub-a',
        projectId: 'proj-a',
        type: HomeEventType.systemEvent,
        occurredAt: DateTime.now(),
      );
      expect(runtime.ingestEvent(wsEvent), isTrue);

      final pushEvent =
          mapPushEnvelopeToHomeEvent({'hubId': 'hub-a', 'eventId': 'evt-1'})!;
      expect(runtime.ingestEvent(pushEvent), isFalse); // same dedup key — suppressed
    });

    test('a push event for an UNAUTHORIZED Home is rejected — never enters that Home\'s runtime',
        () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a']); // hub-b is NOT authorized on this device
      final event = mapPushEnvelopeToHomeEvent({'hubId': 'hub-b', 'eventId': 'evt-1'})!;

      expect(runtime.ingestEvent(event), isFalse);
    });

    test(
        'identical eventId on two DIFFERENT authorized Homes never cross-suppresses each other (§4 isolation)',
        () {
      final runtime = MobileRuntime();
      runtime.updateAuthorizedHomes(['hub-a', 'hub-b']);
      final eventA = mapPushEnvelopeToHomeEvent({'hubId': 'hub-a', 'eventId': 'evt-1'})!;
      final eventB = mapPushEnvelopeToHomeEvent({'hubId': 'hub-b', 'eventId': 'evt-1'})!;

      expect(runtime.ingestEvent(eventA), isTrue);
      expect(runtime.ingestEvent(eventB), isTrue); // different dedup key (hub-b:evt-1)
    });
  });
}
