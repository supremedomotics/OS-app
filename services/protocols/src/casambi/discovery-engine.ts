import type { DiscoveredDevice } from "@supreme/integration-layer";
import { capabilitiesFromUnit, colorConfigFromUnit, type CasambiUnit } from "./entity-mapper.js";
import type { CasambiGroup } from "./cloud-transport.js";
import {
  encodeNotifyControlValuesSetDefaultMask,
  encodeNotifyControlValuesSubscribe,
  encodeNotifyControlValuesUnsubscribe,
  type CasambiUdpEngine,
} from "./local-transport/index.js";

/**
 * Casambi Discovery Engine (§ Casambi Driver Refactor — Foundation + § Architecture Validation).
 * Two genuinely different responsibilities live here, deliberately not forced into one shared
 * interface — see the architecture audit doc for the full reasoning:
 *
 * 1. `buildDiscoveredDevices` — the OUTPUT-shaping half. Turns the cached unit/group model into
 *    Supreme's discovery contract. Fully transport-independent: it only reads the unified
 *    {@link CasambiUnit}/{@link CasambiGroup} shapes the Entity Mapper already normalizes, never a
 *    Cloud- or Local-specific field. `casambi-driver.ts`'s `discover()` calls this exact function
 *    for both connection modes with zero branching.
 * 2. `startLocalDiscovery`/`stopLocalDiscovery` — the DRIVING half for Local mode specifically:
 *    the concrete UDP bootstrap/teardown that makes units start/stop appearing at all (0x4B
 *    SetDefaultMask + Subscribe). This is genuinely UDP-specific — there is no REST equivalent to
 *    factor out alongside it (Cloud's discovery-driving is a REST fetch-then-poll against
 *    driver-owned session/state, an entirely different shape with exactly one real caller; forcing
 *    both through one `DiscoveryDriver` interface today would be the "premature abstraction"
 *    this codebase's own conventions warn against — see TODO.md). What DOES belong here regardless
 *    of that decision is Local's own driving logic, which is why it moved out of
 *    `casambi-driver.ts`'s `connectLocal`/`disconnectLocal` and into this module.
 */
export async function startLocalDiscovery(udp: Pick<CasambiUdpEngine, "send">, netId: number): Promise<void> {
  await udp.send(encodeNotifyControlValuesSetDefaultMask(netId));
  await udp.send(encodeNotifyControlValuesSubscribe(netId, 0, 250));
}

export async function stopLocalDiscovery(udp: Pick<CasambiUdpEngine, "send">, netId: number): Promise<void> {
  await udp.send(encodeNotifyControlValuesUnsubscribe(netId, 0, 250));
}
/** A Casambi group as an installer-facing, pairable unit of work (§ Casambi Group → Supreme Room).
 * Not a `DiscoveredDevice`: a group has no capabilities and isn't commissionable as one device —
 * it's a named set of units whose name is the real room signal the Casambi app already carries. */
export interface CasambiDiscoveredGroup {
  groupId: number;
  name: string;
  /** Ids of the units we actually know about in this group — never the Cloud's full membership
   * list, so the count an installer sees matches what pairing would really commission. */
  unitIds: number[];
}

/**
 * Group-level view of the same cached model {@link buildDiscoveredDevices} shapes per unit.
 * Membership is derived from each unit's own `groupId` (the same signal room mapping already
 * uses) rather than the group's `units` array, so a group can never advertise members this
 * driver has never actually seen. Groups with no known members, or no name, are omitted —
 * an unnamed group carries no room signal and is nothing an installer could act on.
 */
export function buildDiscoveredGroups(
  units: ReadonlyMap<number, CasambiUnit>,
  groups: ReadonlyMap<number, CasambiGroup>,
): CasambiDiscoveredGroup[] {
  const membersByGroup = new Map<number, number[]>();
  for (const unit of units.values()) {
    if (!unit.groupId) continue; // 0/undefined = ungrouped, not a room signal
    if (capabilitiesFromUnit(unit).length === 0) continue; // matches buildDiscoveredDevices' own filter
    const members = membersByGroup.get(unit.groupId);
    if (members) members.push(unit.id);
    else membersByGroup.set(unit.groupId, [unit.id]);
  }
  const out: CasambiDiscoveredGroup[] = [];
  for (const [groupId, unitIds] of membersByGroup) {
    const name = groups.get(groupId)?.name?.trim();
    if (!name) continue;
    out.push({ groupId, name, unitIds: unitIds.sort((a, b) => a - b) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildDiscoveredDevices(
  units: ReadonlyMap<number, CasambiUnit>,
  groups: ReadonlyMap<number, CasambiGroup>,
  /** § Casambi Local Gateway — Cloud device discovery: unit ids known only from the Cloud API,
   * never yet confirmed by a real local UDP signal (see casambi-driver.ts's `cloudOnlyUnitIds`).
   * Reported honestly via `raw.awaitingLocalSignal`, never silently treated as live. Optional —
   * Cloud-mode discovery and existing callers with no such distinction simply omit it. */
  cloudOnlyUnitIds?: ReadonlySet<number>,
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
        awaitingLocalSignal: cloudOnlyUnitIds?.has(unit.id) ?? false,
      },
    });
  }
  return out;
}
