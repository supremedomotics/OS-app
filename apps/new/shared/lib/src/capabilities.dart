/// (§35) Mirrors the Supreme capability vocabulary defined in
/// `packages/domain-model/src/capabilities.ts`. This file must stay in lockstep
/// with that schema — it is not a new vocabulary, it is the Dart projection of
/// the existing one. Never add a capability here that isn't in the TS source.
enum CapabilityKind {
  onoff,
  brightness,
  color,
  temperature,
  position,
  media,
  lock,
  fan,
  vacuum,
  sensor,
}

/// A homeowner-facing domain groups one or more raw capabilities. The UI
/// branches on domain, never on capability or protocol directly (§15).
enum HomeDomain { lighting, shades, climate, audio, security }

const domainCapabilities = <HomeDomain, Set<CapabilityKind>>{
  HomeDomain.lighting: {
    CapabilityKind.onoff,
    CapabilityKind.brightness,
    CapabilityKind.color
  },
  HomeDomain.shades: {CapabilityKind.position},
  HomeDomain.climate: {CapabilityKind.temperature, CapabilityKind.fan},
  HomeDomain.audio: {CapabilityKind.media},
  HomeDomain.security: {CapabilityKind.lock, CapabilityKind.sensor},
};

/// The three honest outcomes for a control the design calls for (§ Capability
/// gating / "the UI is the contract"). Never a fourth silent state.
enum CapabilityAvailability { available, notSupportedByDriver, driverRequired }

CapabilityAvailability capabilityAvailability({
  required bool driverPresent,
  required bool capabilityDeclared,
}) {
  if (!driverPresent) return CapabilityAvailability.driverRequired;
  if (!capabilityDeclared) return CapabilityAvailability.notSupportedByDriver;
  return CapabilityAvailability.available;
}
