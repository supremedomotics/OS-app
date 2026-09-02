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
