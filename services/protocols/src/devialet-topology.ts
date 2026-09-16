import type { DeviceId } from "@supreme/domain-model";

/**
 * Devialet Device → System → Group topology (§ D6) — pure reconciliation only, no
 * I/O, no SupremeOS capability/state concepts. `devialet-driver.ts` is the only
 * caller: it gathers fresh per-device facts via `DevialetIpControlClient`, feeds them
 * to `DevialetTopologyRegistry.merge()`, and owns one registry instance per driver
 * instance (§16 — no module-level mutable state anywhere in this file).
 *
 * § The one load-bearing protocol fact this whole file is built on: the R1 doc
 * defines NO endpoint that returns a System's member device list, and NO endpoint
 * for Group information at all beyond `/groups/{groupId}/sources[/current]` (§ D3
 * report). System/Group membership is therefore NEVER queried directly — it is
 * DERIVED, driver-side, by aggregating every currently-bound device's own
 * `systemId`/`groupId` (from `GET /devices/current`) and grouping devices that report
 * the same id. Two devices sharing a `systemId` are inferred to be system-mates
 * because they both said so, not because any R1 response enumerates them together.
 *
 * § Leader/master — the R1 doc describes "system leader" and "group master" as
 * concepts the firmware selects automatically, but documents NO field or endpoint
 * that reports WHICH device/system holds either role. `leaderDeviceId`/
 * `masterSystemId` are therefore always `null` here — never guessed, never inferred
 * from ordering or any other heuristic (§10 of the D6 brief).
 */

/** One physical Devialet device's current topology facts, as last successfully
 * observed. `deviceId` is Devialet's own stable identity (never IP/host). `systemId`/
 * `groupId`/`role` are `null` for an accessory (Arch/Dialog — the R1 doc: "systemId
 * is only present for speakers... Accessories do not belong to any system[/group]")
 * or for a speaker whose topology genuinely couldn't be determined yet — never
 * fabricated as a guessed system of one. */
export interface DevialetDeviceTopology {
  deviceId: string;
  /** The SupremeOS device this Devialet device is bound to in THIS driver instance —
   * the reverse link `devialet-driver.ts` uses to answer "what's device X's topology"
   * without a second lookup table. */
  supremeDeviceId: DeviceId;
  /** Transport endpoint last used to reach this device — informational only, never
   * part of identity (§2 of the D6 brief). */
  host: string;
  systemId: string | null;
  groupId: string | null;
  /** Exact R1 value ("FrontLeft" | "FrontRight" | "Mono" per the doc), kept as a
   * plain string per `DevialetDeviceInfo.role`'s own established convention (§ D3) —
   * never narrowed to a closed union the doc doesn't promise is exhaustive. `null`
   * for an accessory or an unresolved speaker. */
  role: string | null;
}

export interface DevialetSystemTopology {
  systemId: string;
  /** `null` only if member devices disagree or none has reported a group yet — in
   * practice the R1 doc guarantees every device in one system shares one group, so
   * this is a defensive case, not an expected one. */
  groupId: string | null;
  /** From `GET /systems/current`'s `systemName` — best-effort per-system enrichment
   * (one call per DISTINCT systemId per refresh, not per device). `null` when never
   * successfully fetched. */
  systemName: string | null;
  /** Sorted for deterministic equality/idempotency — never insertion-ordered. */
  memberDeviceIds: string[];
  /** Always `null` — see this module's own doc comment. */
  leaderDeviceId: null;
}

export interface DevialetGroupTopology {
  groupId: string;
  memberSystemIds: string[];
  /** Always `null` — see this module's own doc comment. */
  masterSystemId: null;
}

export interface DevialetTopologySnapshot {
  /** Keyed by Devialet `deviceId`. */
  devices: Record<string, DevialetDeviceTopology>;
  systems: Record<string, DevialetSystemTopology>;
  groups: Record<string, DevialetGroupTopology>;
}

export const EMPTY_DEVIALET_TOPOLOGY: DevialetTopologySnapshot = { devices: {}, systems: {}, groups: {} };

/** One device's freshly-observed facts for one reconciliation pass. `systemName` is
 * `undefined` when this pass didn't attempt to resolve it (falls back to whatever the
 * previous snapshot already had for that systemId), and `null` when it was attempted
 * but genuinely unavailable (e.g. `getSystem()` failed) — the same
 * attempted-vs-unknown distinction the rest of this fleet uses elsewhere. */
export interface DevialetFreshDeviceTopology {
  deviceId: string;
  supremeDeviceId: DeviceId;
  host: string;
  systemId: string | null;
  groupId: string | null;
  role: string | null;
  systemName?: string | null;
}

/**
 * Pure, deterministic. Builds a fresh topology snapshot by MERGING this round's
 * successfully-observed device facts over the previous snapshot, then re-deriving
 * every System/Group purely from the resulting device set.
 *
 * This single merge rule is what satisfies two requirements at once (§17/§18 of the
 * D6 brief) without any special-casing:
 * - a device that failed to answer THIS round (simply absent from `fresh`) keeps its
 *   last-known topology facts untouched — no fabricated "left the system";
 * - a device that DID answer, reporting a new/different `systemId`/`groupId`, causes
 *   its old system's membership to shrink automatically on re-derivation (its entry
 *   is gone from the old system's device set, present in the new one) — real,
 *   confirmed topology change, not a guess.
 *
 * Calling this twice with an identical `fresh` input against the snapshot it just
 * produced returns a deeply-equal snapshot (§23 idempotency) — the sort calls below
 * are what make member-list equality stable regardless of input ordering.
 */
export function buildDevialetTopologySnapshot(previous: DevialetTopologySnapshot, fresh: DevialetFreshDeviceTopology[]): DevialetTopologySnapshot {
  const devices: Record<string, DevialetDeviceTopology> = { ...previous.devices };
  const systemNameOverrides = new Map<string, string | null>();
  for (const f of fresh) {
    devices[f.deviceId] = {
      deviceId: f.deviceId,
      supremeDeviceId: f.supremeDeviceId,
      host: f.host,
      systemId: f.systemId,
      groupId: f.groupId,
      role: f.role,
    };
    if (f.systemId && f.systemName !== undefined) systemNameOverrides.set(f.systemId, f.systemName);
  }

  const systems: Record<string, DevialetSystemTopology> = {};
  for (const device of Object.values(devices)) {
    if (!device.systemId) continue; // accessory or unresolved — never a fabricated system-of-one
    const existing = systems[device.systemId];
    const systemName = systemNameOverrides.has(device.systemId) ? systemNameOverrides.get(device.systemId)! : (existing?.systemName ?? previous.systems[device.systemId]?.systemName ?? null);
    const groupId = existing?.groupId ?? device.groupId ?? null;
    systems[device.systemId] = {
      systemId: device.systemId,
      groupId,
      systemName,
      memberDeviceIds: [...(existing?.memberDeviceIds ?? []), device.deviceId],
      leaderDeviceId: null,
    };
  }
  for (const system of Object.values(systems)) system.memberDeviceIds.sort();

  const groups: Record<string, DevialetGroupTopology> = {};
  for (const system of Object.values(systems)) {
    if (!system.groupId) continue;
    const existing = groups[system.groupId];
    groups[system.groupId] = {
      groupId: system.groupId,
      memberSystemIds: [...(existing?.memberSystemIds ?? []), system.systemId],
      masterSystemId: null,
    };
  }
  for (const group of Object.values(groups)) group.memberSystemIds.sort();

  return { devices, systems, groups };
}

/** Removes one device (by its Devialet `deviceId`) from a snapshot entirely —
 * genuinely unbinding a device, not a transient query failure (see `unbind()` in
 * `devialet-driver.ts`) — and re-derives systems/groups so a now-empty system/group
 * doesn't linger. Pure; returns a new snapshot. */
export function removeDeviceFromTopology(snapshot: DevialetTopologySnapshot, deviceId: string): DevialetTopologySnapshot {
  if (!(deviceId in snapshot.devices)) return snapshot;
  const devices = { ...snapshot.devices };
  delete devices[deviceId];
  return buildDevialetTopologySnapshot({ devices: {}, systems: snapshot.systems, groups: snapshot.groups }, Object.values(devices));
}

export interface DevialetTopologyChange {
  addedDeviceIds: string[];
  removedDeviceIds: string[];
  /** A device present in both snapshots whose `systemId`/`groupId`/`role` differ. */
  changedDeviceIds: string[];
  addedSystemIds: string[];
  removedSystemIds: string[];
  addedGroupIds: string[];
  removedGroupIds: string[];
}

function diffIds(previous: Record<string, unknown>, next: Record<string, unknown>): { added: string[]; removed: string[] } {
  const prevKeys = new Set(Object.keys(previous));
  const nextKeys = new Set(Object.keys(next));
  return {
    added: [...nextKeys].filter((k) => !prevKeys.has(k)).sort(),
    removed: [...prevKeys].filter((k) => !nextKeys.has(k)).sort(),
  };
}

/** Pure diff between two snapshots — deterministic, order-independent (every list is
 * sorted). Used to decide whether a reconciliation pass is worth reporting to a
 * caller (§14 — "old topology, new topology, affected ids"). */
export function diffDevialetTopology(previous: DevialetTopologySnapshot, next: DevialetTopologySnapshot): DevialetTopologyChange {
  const devices = diffIds(previous.devices, next.devices);
  const changedDeviceIds = Object.keys(next.devices)
    .filter((id) => previous.devices[id])
    .filter((id) => {
      const a = previous.devices[id]!;
      const b = next.devices[id]!;
      return a.systemId !== b.systemId || a.groupId !== b.groupId || a.role !== b.role || a.host !== b.host;
    })
    .sort();
  const systems = diffIds(previous.systems, next.systems);
  const groups = diffIds(previous.groups, next.groups);
  return {
    addedDeviceIds: devices.added,
    removedDeviceIds: devices.removed,
    changedDeviceIds,
    addedSystemIds: systems.added,
    removedSystemIds: systems.removed,
    addedGroupIds: groups.added,
    removedGroupIds: groups.removed,
  };
}

export function isTopologyChangeEmpty(change: DevialetTopologyChange): boolean {
  return (
    change.addedDeviceIds.length === 0 &&
    change.removedDeviceIds.length === 0 &&
    change.changedDeviceIds.length === 0 &&
    change.addedSystemIds.length === 0 &&
    change.removedSystemIds.length === 0 &&
    change.addedGroupIds.length === 0 &&
    change.removedGroupIds.length === 0
  );
}

export interface DevialetTopologyChangeResult {
  previous: DevialetTopologySnapshot;
  next: DevialetTopologySnapshot;
  changed: boolean;
  changes: DevialetTopologyChange;
}

/**
 * Instance-owned topology state (§16 — one per `DevialetProtocolDriver` instance,
 * never a module-level singleton). Thin wrapper over the pure functions above: the
 * ONLY thing this class does beyond them is hold "the current snapshot" so
 * `devialet-driver.ts` doesn't have to.
 */
export class DevialetTopologyRegistry {
  private snapshot: DevialetTopologySnapshot = EMPTY_DEVIALET_TOPOLOGY;

  get(): DevialetTopologySnapshot {
    return this.snapshot;
  }

  merge(fresh: DevialetFreshDeviceTopology[]): DevialetTopologyChangeResult {
    const previous = this.snapshot;
    const next = buildDevialetTopologySnapshot(previous, fresh);
    const changes = diffDevialetTopology(previous, next);
    this.snapshot = next;
    return { previous, next, changed: !isTopologyChangeEmpty(changes), changes };
  }

  remove(deviceId: string): DevialetTopologyChangeResult {
    const previous = this.snapshot;
    const next = removeDeviceFromTopology(previous, deviceId);
    const changes = diffDevialetTopology(previous, next);
    this.snapshot = next;
    return { previous, next, changed: !isTopologyChangeEmpty(changes), changes };
  }
}
