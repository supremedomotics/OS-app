import 'provisioning.dart';

/// The outcome of checking a Hub-supplied configuration against what this
/// panel trusts (§Phase9-9/10). Deliberately three honest outcomes, mirroring
/// `capabilityAvailability()`'s pattern — never a silent "assume it's fine."
enum ConfigVerificationResult {
  verified,
  rejectedInvalidSignature,
  rejectedStaleVersion
}

/// A signed/authoritative configuration payload as the Hub would present it
/// over the wire, before the panel decides whether to trust it. `signature`
/// is opaque to this type — [HubConfigVerifier] owns what it means.
class SignedPanelConfig {
  final PanelAssignment assignment;
  final ProvisioningState provisioningState;
  final int configurationVersion;
  final String signature;

  const SignedPanelConfig({
    required this.assignment,
    required this.provisioningState,
    required this.configurationVersion,
    required this.signature,
  });
}

/// Verifies that a [SignedPanelConfig] genuinely came from the Hub this
/// panel trusts, and is not older than what the panel already has (§Phase9-9:
/// "a locally edited JSON cache must not be capable of changing room/floor/
/// whole-home scope/project/panel identity" — this is the check that makes
/// that true no matter what the on-disk cache file says).
///
/// HONEST STATUS (§Phase9-10, §Phase9-21): this interface is real and the
/// version/monotonicity check below is real and safe to rely on. Signature
/// verification itself is NOT a production cryptographic implementation in
/// this phase — see [DeterministicHmacConfigVerifier], which is a clearly
/// labeled, deterministic stand-in for tests and early integration, not a
/// security control. A production implementation should verify an
/// Ed25519/similar signature against a public key established during panel
/// enrollment (matching the direction of this repo's existing Hub-identity
/// work), never a shared-secret HMAC — replacing this class is the seam.
abstract class HubConfigVerifier {
  ConfigVerificationResult verify({
    required SignedPanelConfig incoming,
    required int? currentConfigurationVersion,
  });
}

/// Deterministic, test/integration-only verifier — NOT production
/// cryptography (§Phase9-10, §Phase9-21). Treats `signature` as valid only
/// if it equals a shared, hardcoded-for-tests HMAC-shaped string; a real
/// implementation replaces this entirely rather than hardening it in place.
class DeterministicHmacConfigVerifier implements HubConfigVerifier {
  /// The one "known-good" signature value this stand-in accepts — a real
  /// verifier would instead check a public-key signature, with no shared
  /// secret to leak.
  final String trustedSignature;

  const DeterministicHmacConfigVerifier(
      {this.trustedSignature = 'test-hub-signature-v1'});

  @override
  ConfigVerificationResult verify({
    required SignedPanelConfig incoming,
    required int? currentConfigurationVersion,
  }) {
    if (incoming.signature != trustedSignature) {
      return ConfigVerificationResult.rejectedInvalidSignature;
    }
    // Monotonic version check: a real (or replayed/rolled-back) config must
    // never move the panel backwards — this is the concrete mechanism
    // behind "compare with cache" in the revalidation flow.
    if (currentConfigurationVersion != null &&
        incoming.configurationVersion < currentConfigurationVersion) {
      return ConfigVerificationResult.rejectedStaleVersion;
    }
    return ConfigVerificationResult.verified;
  }
}
