import 'sip_domain.dart';

/// One configured door station within a Home (§Phase13.5 §"MULTIPLE DOOR STATIONS") — a Home may
/// have several (`Entrance`, `Gate`, `Basement`, ...), each independently identified. [remoteUri]
/// is the door station's own SIP identity as it appears in an inbound INVITE's From — how
/// `SipService` matches a ringing call to this configuration (never inferred from display name).
class SipDoorStationConfig {
  final String doorStationId;
  final String label;
  final String remoteUri;

  const SipDoorStationConfig({
    required this.doorStationId,
    required this.label,
    required this.remoteUri,
  });
}

/// Registration credentials for one Home's SIP account. Deliberately NOT `Equatable`/serializable
/// with a printable `toString` — never logged, never included in a crash report, never placed in
/// a Push payload/CallKit metadata/Android Intent extra (§Phase13.5 §SECURITY). Held only for the
/// duration of a `SipEngine.registerAccount` call; `SipService` does not retain it afterwards.
class SipCredentials {
  final String authUsername;
  final String password;
  const SipCredentials({required this.authUsername, required this.password});

  @override
  String toString() => 'SipCredentials(authUsername: $authUsername, password: ***)';
}

/// One Home's SIP account configuration — this is the account SupremeOS itself registers as (the
/// residence's own SIP identity on the Hub's embedded proxy/registrar), distinct from the door
/// stations it receives calls from (§ "Do NOT use one global SIP account").
class SipAccountConfig {
  final String hubId;
  final String projectId;
  final String sipUri;
  final SipTransport transport;
  final List<SipDoorStationConfig> doorStations;

  const SipAccountConfig({
    required this.hubId,
    required this.projectId,
    required this.sipUri,
    required this.transport,
    this.doorStations = const [],
  });

  /// Matches an inbound call's raw remote URI to a configured door station — returns null for an
  /// unmapped/unknown remote identity (never guesses).
  SipDoorStationConfig? doorStationFor(String remoteUri) {
    for (final d in doorStations) {
      if (d.remoteUri == remoteUri) return d;
    }
    return null;
  }
}

enum SipRegistrationState { unregistered, registering, registered, failed, expired }

/// Current registration status for one Home's account — `SipService`'s per-Home stream feeds
/// Professional Mode diagnostics (§ DIAGNOSTICS) and the (future) Settings → Home connectivity
/// surface; never shown to a homeowner as raw SIP state.
class SipRegistrationStatus {
  final String hubId;
  final SipRegistrationState state;
  final DateTime? expiresAt;
  final SipFailure? lastFailure;

  const SipRegistrationStatus({
    required this.hubId,
    required this.state,
    this.expiresAt,
    this.lastFailure,
  });

  SipRegistrationStatus copyWith({
    SipRegistrationState? state,
    DateTime? expiresAt,
    SipFailure? lastFailure,
    bool clearExpiresAt = false,
    bool clearFailure = false,
  }) =>
      SipRegistrationStatus(
        hubId: hubId,
        state: state ?? this.state,
        expiresAt: clearExpiresAt ? null : (expiresAt ?? this.expiresAt),
        lastFailure: clearFailure ? null : (lastFailure ?? this.lastFailure),
      );
}
