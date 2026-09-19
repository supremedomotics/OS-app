/// SupremeOS Mobile Runtime — semantic event/session models (§Phase12.5). Pure Dart, no
/// platform dependency, shared by Mobile and Tablet's background runtime exactly like every
/// other model in this package (§18: "the shared package must remain platform-neutral").
///
/// These types exist BEFORE any platform wiring because the phase's own instruction (§23) is
/// to establish the semantic contract first, then implement only what the Hub can actually
/// back today — see the HONEST STATUS notes on [CallSession] and [MobileRuntime] for exactly
/// what that is.
library;

/// One residential occurrence the background runtime may need to react to — a doorphone ring,
/// a security event, a state change — always anchored to a CANONICAL Home, never a display
/// name (§3: "never identify a Home using its editable display name").
class HomeEvent {
  /// Stable identifier for THIS occurrence — used for deduplication (§13). Hub-issued when the
  /// Hub provides one; if the Hub has no sequence/id concept for a given source yet, callers
  /// must not fabricate one that looks authoritative (see `SeenEventTracker`'s doc).
  final String eventId;

  /// Canonical identity — matches `HubIdentity.hubId`/`PairedHome.hubId`. NEVER a display name.
  final String hubId;
  final String projectId;

  final HomeEventType type;
  final DateTime occurredAt;

  /// Optional scoping — which room/entity this concerns, when the event has one.
  final String? roomId;
  final String? entityId;

  final HomeEventSeverity severity;

  /// Opaque, event-type-specific payload — never a protocol concept (no SIP/KNX/Matter term
  /// belongs here; see [HomeEventType] for the vocabulary this is allowed to carry).
  final Map<String, dynamic> payload;

  const HomeEvent({
    required this.eventId,
    required this.hubId,
    required this.projectId,
    required this.type,
    required this.occurredAt,
    this.roomId,
    this.entityId,
    this.severity = HomeEventSeverity.info,
    this.payload = const {},
  });

  /// The identity a dedup/isolation store keys on — `(hubId, eventId)`, never `eventId` alone
  /// (§13: two Homes' event streams must never collide even if a bug ever produced the same
  /// raw id from two different Hubs).
  String get dedupKey => '$hubId:$eventId';
}

enum HomeEventSeverity { info, warning, critical }

/// The residential occurrences this runtime is actually specified to handle (§16). Deliberately
/// closed — adding a new kind here is a deliberate architectural decision, not something a
/// caller invents ad hoc.
enum HomeEventType {
  doorphoneRing,
  doorphoneMissed,
  securityAlert,
  deviceStateChanged,
  systemEvent,
}

/// §4 — the doorphone call state machine. Deliberately the exact 8 states the phase specifies,
/// no more, no fewer.
enum CallState {
  idle,
  incoming,
  ringing,
  connecting,
  connected,
  ending,
  ended,
  failed
}

enum CallMedia { voice, video }

/// One doorphone call session, canonically anchored (never by display name).
///
/// HONEST STATUS — SIP BACKEND: BACKEND CONTRACT MISSING (§17, §22). Real inspection of
/// `services/protocols/src/sip-driver.ts` found: a real, tested capability MAPPING exists
/// (door release → `lock` capability, ring → a `sensor` capability pulse) but NO live
/// two-way audio/video call session concept exists anywhere in the Hub — `SipProtocolDriver`
/// has no media/RTP handling, and its own default user agent factory
/// (`defaultSipStation`) THROWS in production ("no user agent configured") unless a real SIP
/// UA is injected, which nothing in `bootstrap.ts` currently does. This class defines the
/// CLIENT-side shape a real call session would need — call state machine, media kind, remote
/// party — so the Mobile runtime has a stable interface to implement against once the Hub
/// side is built; it is NOT claiming a call can currently be placed or received.
class CallSession {
  final String callId;
  final String hubId;
  final String projectId;
  final CallMedia media;
  final CallState state;
  final DateTime startedAt;
  final String? doorStationLabel;

  /// §Phase13.5 — stable door-station identity (from the Home's configured door-station list,
  /// never inferred from display name) — present once `SipService` has matched the incoming
  /// call's remote SIP identity to a configured door station; null if the call came from an
  /// unmapped/unknown remote identity (never fabricated).
  final String? doorStationId;

  const CallSession({
    required this.callId,
    required this.hubId,
    required this.projectId,
    required this.media,
    required this.state,
    required this.startedAt,
    this.doorStationLabel,
    this.doorStationId,
  });

  CallSession copyWith({CallState? state}) => CallSession(
        callId: callId,
        hubId: hubId,
        projectId: projectId,
        media: media,
        state: state ?? this.state,
        startedAt: startedAt,
        doorStationLabel: doorStationLabel,
        doorStationId: doorStationId,
      );
}

/// A single device's push-notification registration for ONE Home (§6, §3: multi-Home aware —
/// one Mobile install registers a token per authorized Home it wants background delivery
/// for, since the real server-side contract, `POST /v1/push/tokens`
/// (`services/gateway/src/routes/notifications.ts`), is per-authenticated-request, and this
/// runtime authenticates each Home's registration with THAT Home's own Mobile-authorization
/// bearer token (Phase 12.4's bridge) — never a token shared across Homes.
class PushRegistration {
  final String hubId;
  final String projectId;
  final String
      platform; // "fcm" | "apns" | "webpush" — matches the real server contract.
  final String token;
  final DateTime registeredAt;

  const PushRegistration({
    required this.hubId,
    required this.projectId,
    required this.platform,
    required this.token,
    required this.registeredAt,
  });
}
