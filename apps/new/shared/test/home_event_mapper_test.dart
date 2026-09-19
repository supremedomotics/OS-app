import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

void main() {
  const mapper = HomeEventMapper();

  group('HomeEventMapper — real /v1/stream frame shapes (§Phase12.6)', () {
    test(
        'a "state" frame maps to deviceStateChanged, stamped with the caller\'s hubId/projectId',
        () {
      final event = mapper.map(
        {
          'type': 'state',
          'homeId': 'home_1',
          'roomId': 'room_1',
          'deviceId': 'dev_1',
          'state': {'kind': 'onoff', 'on': true},
          'seq': 3,
          'ts': '2026-01-01T00:00:00.000Z',
        },
        hubId: 'hub-a',
        projectId: 'proj-a',
      );

      expect(event, isNotNull);
      expect(event!.type, HomeEventType.deviceStateChanged);
      expect(event.hubId, 'hub-a');
      expect(event.projectId, 'proj-a');
      expect(event.roomId, 'room_1');
      expect(event.entityId, 'dev_1');
      expect(event.eventId, 'dev_1:3');
    });

    test(
        'a sensor "ring" state frame maps to doorphoneRing, not a generic state change',
        () {
      final event = mapper.map(
        {
          'type': 'state',
          'homeId': 'home_1',
          'roomId': 'room_1',
          'deviceId': 'dev_doorphone',
          'state': {
            'kind': 'sensor',
            'value': 1,
            'unit': '',
            'measure': 'ring'
          },
          'seq': 1,
          'ts': '2026-01-01T00:00:00.000Z',
        },
        hubId: 'hub-a',
        projectId: 'proj-a',
      );

      expect(event!.type, HomeEventType.doorphoneRing);
    });

    test('a non-ring sensor state frame stays a generic device state change',
        () {
      final event = mapper.map(
        {
          'type': 'state',
          'homeId': 'home_1',
          'roomId': 'room_1',
          'deviceId': 'dev_1',
          'state': {
            'kind': 'sensor',
            'value': 21.5,
            'unit': 'C',
            'measure': 'temperature'
          },
          'seq': 1,
          'ts': '2026-01-01T00:00:00.000Z',
        },
        hubId: 'hub-a',
        projectId: 'proj-a',
      );

      expect(event!.type, HomeEventType.deviceStateChanged);
    });

    test('a "notification" frame maps to a systemEvent with the right severity',
        () {
      final event = mapper.map(
        {
          'type': 'notification',
          'level': 'critical',
          'title': 'Water leak detected',
          'body': 'Basement sensor',
          'ts': '2026-01-01T00:00:00.000Z',
        },
        hubId: 'hub-a',
        projectId: 'proj-a',
      );

      expect(event!.type, HomeEventType.systemEvent);
      expect(event.severity, HomeEventSeverity.critical);
    });

    test('a "driver" frame maps to a systemEvent scoped to the driver id', () {
      final event = mapper.map(
        {
          'type': 'driver',
          'driverId': 'knx',
          'state': 'disconnected',
          'ts': '2026-01-01T00:00:00.000Z',
        },
        hubId: 'hub-a',
        projectId: 'proj-a',
      );

      expect(event!.type, HomeEventType.systemEvent);
      expect(event.entityId, 'knx');
    });

    test(
        'an unsupported frame type (ack/pong/error) returns null, never throws',
        () {
      expect(
        mapper.map({'type': 'ack', 'requestId': 'r1', 'accepted': true},
            hubId: 'hub-a', projectId: 'proj-a'),
        isNull,
      );
      expect(
        mapper.map({'type': 'pong', 'ts': '2026-01-01T00:00:00.000Z'},
            hubId: 'hub-a', projectId: 'proj-a'),
        isNull,
      );
    });

    test(
        'a malformed state frame (missing deviceId) returns null rather than throwing',
        () {
      expect(
        () => mapper.map(
            {'type': 'state', 'seq': 1, 'ts': '2026-01-01T00:00:00.000Z'},
            hubId: 'hub-a', projectId: 'proj-a'),
        returnsNormally,
      );
      expect(
        mapper.map(
            {'type': 'state', 'seq': 1, 'ts': '2026-01-01T00:00:00.000Z'},
            hubId: 'hub-a', projectId: 'proj-a'),
        isNull,
      );
    });

    test(
        'two Homes mapping the identical raw frame get independently hubId-stamped events',
        () {
      final rawFrame = {
        'type': 'state',
        'deviceId': 'dev_1',
        'state': {'kind': 'onoff', 'on': true},
        'seq': 1,
        'ts': '2026-01-01T00:00:00.000Z',
      };

      final eventA = mapper.map(rawFrame, hubId: 'hub-a', projectId: 'proj-a');
      final eventB = mapper.map(rawFrame, hubId: 'hub-b', projectId: 'proj-b');

      expect(eventA!.hubId, 'hub-a');
      expect(eventB!.hubId, 'hub-b');
      expect(eventA.dedupKey,
          isNot(eventB.dedupKey)); // never collide across Homes
    });
  });
}
