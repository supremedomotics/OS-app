import type { DiscoveredDevice } from "@supreme/integration-layer";
import { capabilitiesFromUnit, colorConfigFromUnit, type CasambiUnit } from "./entity-mapper.js";
import type { CasambiGroup } from "./cloud-transport.js";

/**
 * Casambi Discovery Engine (§ Casambi Driver Refactor — Foundation). Turns the cached unit/group
 * model — sourced from Cloud REST today, Local REST in PR-2 — into Supreme's discovery contract.
 * Transport-independent: it only reads the unified {@link CasambiUnit}/{@link CasambiGroup} shapes
 * the Entity Mapper already normalizes, never a Cloud- or Local-specific field. Extracted verbatim
 * from the working driver's `discover()` body — same output for the same input, no behavior change.
 */
export function buildDiscoveredDevices(
  units: ReadonlyMap<number, CasambiUnit>,
  groups: ReadonlyMap<number, CasambiGroup>,
): DiscoveredDevice[] {
  const out: DiscoveredDevice[] = [];
  for (const unit of units.values()) {
    const capabilities = capabilitiesFromUnit(unit);
    if (capabilities.length === 0) continue;
    const group = unit.groupId ? groups.get(unit.groupId) : undefined;
    const colorConfig = colorConfigFromUnit(unit);
    out.push({
      backendId: `casambi:${unit.id}`,
      suggestedName: unit.name?.trim() || `Casambi ${unit.id}`,
      capabilities,
      // § ADR 0017 Capability Normalization — the real RGB/CCT distinction, known from this
      // unit's advertised controls at discovery time, never guessed from live state.
      ...(colorConfig ? { capabilityConfig: { color: colorConfig } } : {}),
      // The Casambi group name auto-maps this luminaire to a Supreme room at commissioning.
      raw: {
        unitId: unit.id,
        address: unit.address ?? null,
        fixtureId: unit.fixtureId ?? null,
        groupId: unit.groupId ?? 0,
        room: group?.name ?? null,
        type: unit.type ?? null,
      },
    });
  }
  return out;
}
