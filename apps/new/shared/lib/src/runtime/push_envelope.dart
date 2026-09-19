import 'home_event.dart';

/// §Phase13.2 §7 — parses the minimal, non-authoritative routing envelope a push payload
/// carries (`services/notifications/src/push.ts`'s `PushEnvelope`, stamped into every push
/// message's `data` map by `PushService.deliver`) into the SAME [HomeEvent] shape
/// `HomeEventMapper` produces from `/v1/stream` frames — so a push notification is ingested
/// through the EXACT SAME `MobileRuntime.ingestEvent` pipeline as a live WebSocket event,
/// reusing its existing hub-authorization filtering and `(hubId, eventId)` dedup (§8: "do not
/// confuse push deduplication with WebSocket event deduplication" — they are separate
/// TRANSPORTS, but this deliberately makes them share one DEDUP MECHANISM rather than
/// inventing a second one, since both ultimately produce the same [HomeEvent] identity).
///
/// Returns `null` for a malformed/incomplete payload (missing `hubId`/`eventId`) — the SAME
/// "drop, never throw" policy `HomeEventMapper` and `WebSocketHubEventStream` already use for
/// an unrecognized/malformed frame (§ malformed-payload handling, §12 "unknown push event").
///
/// HONEST SIMPLIFICATION: the current server-side envelope does not yet carry a specific
/// [HomeEventType] (only a generic notification `level`) — every push-derived event maps to
/// [HomeEventType.systemEvent] until the Hub tags notifications with a real event-type
/// vocabulary. This is a real, working mapping, not a placeholder: the dedup/isolation
/// guarantees hold today regardless of event-type granularity.
HomeEvent? mapPushEnvelopeToHomeEvent(Map<String, dynamic> data) {
  final hubId = data['hubId'];
  final eventId = data['eventId'];
  if (hubId is! String || hubId.isEmpty) return null;
  if (eventId is! String || eventId.isEmpty) return null;

  final tsRaw = data['ts'];
  final occurredAt =
      tsRaw is String ? DateTime.tryParse(tsRaw) ?? DateTime.now() : DateTime.now();

  final severity = switch (data['level']) {
    'critical' => HomeEventSeverity.critical,
    'warning' => HomeEventSeverity.warning,
    _ => HomeEventSeverity.info,
  };

  return HomeEvent(
    eventId: eventId,
    // §Phase13.2 §3 — `projectId` is NOT carried in the push envelope today (the envelope's
    // whole job is routing/dedup, not full Home identity restatement); `MobileRuntime.ingestEvent`
    // only checks `hubId` against the authorized-hub set, so this is sufficient for correct
    // isolation. A caller that needs `projectId` (e.g. to render a Home name) looks it up from
    // `PairedHomeController` by this same canonical `hubId`, never from the push payload.
    hubId: hubId,
    projectId: '',
    type: HomeEventType.systemEvent,
    occurredAt: occurredAt,
    severity: severity,
  );
}
