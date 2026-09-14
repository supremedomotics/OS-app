import 'mobile_identity.dart';

/// Result of a pairing ceremony (§Phase11-7/8): the Hub has authorized THIS
/// Mobile identity for THIS project, and issued a session token the Mobile
/// uses as its `RemoteHubConfig.bearerToken` going forward (§Phase10's
/// `RemoteHubTransport` already accepts any token-producing closure — this
/// is the real thing that produces it, not a placeholder).
///
/// Deliberately does NOT use `hubId + MAC address` (§Phase11-8: explicitly
/// forbidden) — authorization is bound to [mobileId] (the Ed25519-identified
/// device) and [hubId]/[projectId], established via a signed challenge.
class MobileAuthorization {
  final String mobileId;
  final String hubId;
  final String projectId;
  final String token;
  final DateTime issuedAt;
  final DateTime? expiresAt;

  const MobileAuthorization({
    required this.mobileId,
    required this.hubId,
    required this.projectId,
    required this.token,
    required this.issuedAt,
    this.expiresAt,
  });

  bool isExpiredAt(DateTime now) =>
      expiresAt != null && !now.isBefore(expiresAt!);
}

/// Thrown when a Hub rejects a pairing attempt (wrong/expired pairing code,
/// this Mobile identity was previously revoked, malformed request, etc).
class PairingException implements Exception {
  final String message;
  const PairingException(this.message);
  @override
  String toString() => 'PairingException: $message';
}

/// What the pairing ceremony needs to send a request and get a response —
/// deliberately NOT `HubTransport`, because pairing happens before a
/// `MobileAuthorization` exists (there is no bearer token yet to build a
/// `RemoteHubTransport` from). A real app backs this with a plain HTTPS
/// call to the Hub's pairing endpoint (LAN, during the ceremony — pairing
/// itself is a local-network/local-approval action per §Phase11-8, not
/// something done over the Internet against a Hub you've never met).
///
/// HONEST STATUS: SERVER-SIDE REQUIRED. No `/v1/pairing/*` Hub endpoint
/// exists yet in `services/gateway` — this interface documents the exact
/// request/response contract such an endpoint would need to implement, and
/// [PairingClient] below drives it faithfully, but nothing calls a real
/// server today outside tests (which fake this interface, clearly labeled).
abstract class PairingTransport {
  /// Homeowner enters a Hub-displayed short-lived pairing code (or scans its
  /// QR encoding) — this exchanges it for a fresh, single-use challenge tied
  /// to that code, so the code itself is never the credential.
  Future<PairingChallengeResponse> requestChallenge(
      {required String pairingCode, required String mobilePublicKeyBase64});

  /// Mobile proves ownership of its private key by signing the challenge,
  /// and this call presents that proof back to the Hub for approval.
  Future<MobileAuthorization> submitSignedChallenge({
    required String challengeId,
    required String signatureBase64,
  });
}

class PairingChallengeResponse {
  final String challengeId;
  final List<int> challengeBytes;
  final String hubId;
  final String projectId;

  const PairingChallengeResponse({
    required this.challengeId,
    required this.challengeBytes,
    required this.hubId,
    required this.projectId,
  });
}

/// Drives the real pairing ceremony end-to-end using a real Ed25519 identity
/// (§Phase11-7). Never invents a "hubId + MAC" shortcut, never fabricates an
/// authorization — every step is a real signed request/response, so the
/// only thing "not real" is whether a live Hub is on the other end of
/// [PairingTransport] (that's the SERVER-SIDE REQUIRED gap, not this class).
class PairingClient {
  final Ed25519MobileIdentity identity;
  final PairingTransport transport;

  PairingClient({required this.identity, required this.transport});

  Future<MobileAuthorization> pairUsingCode(String pairingCode) async {
    var mobile = await identity.load();
    mobile ??= await identity.generateAndPersist();

    final challenge = await transport.requestChallenge(
      pairingCode: pairingCode,
      mobilePublicKeyBase64: mobile.publicKeyBase64,
    );

    final signature = await identity.sign(challenge.challengeBytes);

    return transport.submitSignedChallenge(
      challengeId: challenge.challengeId,
      signatureBase64: signature,
    );
  }
}

/// Hub-side authorization record shape a real pairing endpoint would persist
/// per paired Mobile (§Phase11-7/17/26) — included here so Mobile-side code
/// and a future server implementation agree on the same fields, even though
/// the actual persistence/registry lives server-side (SERVER-SIDE REQUIRED).
/// Multiple [MobileAuthorizationRecord]s per Hub is the normal case
/// (§Phase11-26: "Owner iPhone, Owner iPad, Partner iPhone…").
class MobileAuthorizationRecord {
  final String mobileId;
  final String publicKeyBase64;
  final String hubId;
  final String projectId;
  final String label;
  final DateTime pairedAt;
  final bool revoked;

  const MobileAuthorizationRecord({
    required this.mobileId,
    required this.publicKeyBase64,
    required this.hubId,
    required this.projectId,
    required this.label,
    required this.pairedAt,
    this.revoked = false,
  });

  Map<String, dynamic> toJson() => {
        'mobileId': mobileId,
        'publicKeyBase64': publicKeyBase64,
        'hubId': hubId,
        'projectId': projectId,
        'label': label,
        'pairedAt': pairedAt.toIso8601String(),
        'revoked': revoked,
      };

  static MobileAuthorizationRecord fromJson(Map<String, dynamic> json) =>
      MobileAuthorizationRecord(
        mobileId: json['mobileId'] as String,
        publicKeyBase64: json['publicKeyBase64'] as String,
        hubId: json['hubId'] as String,
        projectId: json['projectId'] as String,
        label: json['label'] as String,
        pairedAt: DateTime.parse(json['pairedAt'] as String),
        revoked: json['revoked'] as bool? ?? false,
      );
}

/// Turns an issued [MobileAuthorization] into the `bearerToken` closure
/// `RemoteHubConfig` already expects (§Phase10's `RemoteHubConfig
/// .bearerToken`) — no change needed to `RemoteHubTransport` itself; this is
/// the real token source Phase 10's doc comment said was still missing.
///
/// Also enforces expiry/revocation client-side before ever attempting a
/// remote call: a revoked or expired authorization throws rather than
/// silently sending a stale token (§Phase11-17: revocation must actually
/// stop use, not just exist as a server-side flag the client ignores).
class AuthorizedMobileSession {
  MobileAuthorization _authorization;
  bool _revoked = false;

  AuthorizedMobileSession(this._authorization);

  MobileAuthorization get authorization => _authorization;

  void replaceAuthorization(MobileAuthorization next) {
    _authorization = next;
  }

  /// Call when the Hub/broker reports this session as revoked (e.g. a 403
  /// from the broker per §Phase11-9, or an explicit push from the Hub).
  void markRevoked() {
    _revoked = true;
  }

  String bearerToken() {
    if (_revoked) {
      throw const PairingException('this Mobile identity has been revoked');
    }
    if (_authorization.isExpiredAt(DateTime.now())) {
      throw const PairingException('authorization expired — re-pair required');
    }
    return _authorization.token;
  }
}
