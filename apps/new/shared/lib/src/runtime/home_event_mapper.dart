import 'home_event.dart';

/// Translates a REAL `/v1/stream` frame (`services/gateway/src/stream.ts` — the existing
/// production Hub Event Bus fan-out, unchanged by §Phase12.6, only its authentication was
/// extended) into a [HomeEvent] the Mobile Runtime understands. This is the "keep the
/// semantic boundary intact" layer (§10/§17): nothing downstream of this function ever sees
/// a raw stream frame shape.
///
/// The caller supplies [hubId]/[projectId] itself (§3/§8) — canonical identity is a property
/// of WHICH connection this frame arrived on (one `HubTransport`/event-stream connection per
/// Home), never something read out of the frame body, which carries no `hubId` field at all
/// (a single Hub process serves exactly one home, so the real server never needed to stamp
/// one — see `stream.ts`'s own frames).
class HomeEventMapper {
  const HomeEventMapper();

  /// Returns null for a frame type this Mobile Runtime has no semantic mapping for (§14 —
  /// "unsupported events" must be dropped cleanly, never thrown as a crash) — e.g. `ack`/
  /// `pong`, which are protocol plumbing the runtime doesn't need to surface as a `HomeEvent`.
  HomeEvent? map(Map<String, dynamic> frame,
      {required String hubId, required String projectId}) {
    final type = frame['type'] as String?;
    switch (type) {
      case 'state':
        return _mapState(frame, hubId: hubId, projectId: projectId);
      case 'notification':
        return _mapNotification(frame, hubId: hubId, projectId: projectId);
      case 'driver':
        return _mapDriver(frame, hubId: hubId, projectId: projectId);
      default:
        return null; // ack/pong/error/subscribe-echo — not a HomeEvent, not an error either.
    }
  }

  HomeEvent? _mapState(Map<String, dynamic> frame,
      {required String hubId, required String projectId}) {
    final deviceId = frame['deviceId'] as String?;
    final ts = frame['ts'] as String?;
    if (deviceId == null || ts == null)
      return null; // malformed — dropped, never throws (§14).
    final state = frame['state'] as Map<String, dynamic>?;

    // §14/§Phase12.5 heuristic: a `sensor` capability pulse specifically tagged `measure:
    // "ring"` is the doorphone's ring signal (`services/protocols/src/sip-driver.ts`'s
    // `onRing()` — see that file's own doc for why this is the ONLY doorphone signal that
    // exists today; there is no real call-session event, only this capability-level pulse).
    final isRing = state?['kind'] == 'sensor' && state?['measure'] == 'ring';

    return HomeEvent(
      // The real server assigns no stable id to a state delta beyond its per-device `seq`
      // (in-memory, per-connection — see class doc on replay) — `deviceId:seq` is the most
      // stable identity available, never a fabricated server sequence (§13/§3 "do not invent
      // server sequence numbers").
      eventId: '$deviceId:${frame['seq']}',
      hubId: hubId,
      projectId: projectId,
      type: isRing
          ? HomeEventType.doorphoneRing
          : HomeEventType.deviceStateChanged,
      occurredAt: DateTime.parse(ts),
      roomId: frame['roomId'] as String?,
      entityId: deviceId,
      payload: state ?? const {},
    );
  }

  HomeEvent? _mapNotification(Map<String, dynamic> frame,
      {required String hubId, required String projectId}) {
    final ts = frame['ts'] as String?;
    if (ts == null) return null;
    final level = frame['level'] as String?;
    return HomeEvent(
      // Notifications carry no id at all server-side (`NotificationFrame` — title/body/level/
      // ts only); the timestamp + body is the least-bad stable identity available without
      // inventing one the Hub doesn't provide.
      eventId: 'notification:$ts:${frame['title']}',
      hubId: hubId,
      projectId: projectId,
      type: HomeEventType.systemEvent,
      occurredAt: DateTime.parse(ts),
      severity: level == 'critical'
          ? HomeEventSeverity.critical
          : level == 'warning'
              ? HomeEventSeverity.warning
              : HomeEventSeverity.info,
      payload: {'title': frame['title'], 'body': frame['body']},
    );
  }

  HomeEvent? _mapDriver(Map<String, dynamic> frame,
      {required String hubId, required String projectId}) {
    final ts = frame['ts'] as String?;
    final driverId = frame['driverId'] as String?;
    if (ts == null || driverId == null) return null;
    return HomeEvent(
      eventId: 'driver:$driverId:$ts',
      hubId: hubId,
      projectId: projectId,
      type: HomeEventType.systemEvent,
      occurredAt: DateTime.parse(ts),
      entityId: driverId,
      payload: {
        'state': frame['state'],
        if (frame['error'] != null) 'error': frame['error']
      },
    );
  }
}
