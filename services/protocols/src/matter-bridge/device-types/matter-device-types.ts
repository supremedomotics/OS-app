import type { CapabilityCommand } from "@supreme/domain-model";
import { MatterClusterId } from "./matter-cluster-ids.js";

/** One cluster a device type requires or permits — a thin, named wrapper around the id so a
 * definition reads as "Identify, OnOff, LevelControl" rather than a bare hex array. */
export interface MatterClusterRequirement {
  clusterId: number;
  clusterName: string;
}

function cluster(id: (typeof MatterClusterId)[keyof typeof MatterClusterId]): MatterClusterRequirement {
  const name = Object.entries(MatterClusterId).find(([, v]) => v === id)?.[0] ?? String(id);
  return { clusterId: id, clusterName: name };
}

/**
 * One Matter Device Type, per the official Matter 1.6 Device Type Library (§ Matter Bridge
 * Phase 1 foundation — "Matter Device Type is the authoritative answer to 'what is this
 * endpoint?'"). `id`/`revision`/`requiredServerClusters`/`optionalServerClusters` are NOT
 * hand-guessed: they are transcribed directly from `@matter/node`'s own generated device
 * definitions (`node_modules/@matter/node/src/devices/*.ts`, e.g. `dimmable-light.ts`,
 * `color-temperature-light.ts`, `extended-color-light.ts`, `window-covering.ts`), which are
 * themselves generated from the CSA's official Matter specification — the same source of truth
 * this codebase's real `@matter/main` runtime already uses to actually build these endpoints
 * (`real-server.ts`). There is no second, independently-sourced device-type table to drift out
 * of sync with what the SDK enforces at runtime.
 *
 * `primaryCapability` is a Phase-1-specific, bridge-direction addition (not part of the Matter
 * spec itself): the ONE SupremeOS capability kind whose state fully drives this device type's
 * Matter attributes in the SupremeOS→Matter (bridge/outbound) direction. This works cleanly
 * because SupremeOS's own capability model already merges what Matter splits across multiple
 * clusters into one capability's state (`ColorState` alone carries on/level/hue/saturation/
 * kelvin — see `packages/domain-model/src/capabilities.ts`) — so exactly one capability per
 * device type is enough to seed and mirror every cluster this device type requires. Phase 2's
 * controller-side (Matter→SupremeOS discovery) direction will NOT reuse this field — a
 * discovered endpoint's capabilities are built UP from its actual cluster set, not resolved
 * down from a single presumed capability; `requiredServerClusters`/`optionalServerClusters`
 * are what Phase 2 reuses from this same registry.
 */
export interface MatterDeviceTypeDefinition {
  id: number;
  name: string;
  revision: number;
  requiredServerClusters: MatterClusterRequirement[];
  optionalServerClusters: MatterClusterRequirement[];
  /** § Phase 1 bridge-direction only — see doc comment above. */
  primaryCapability: CapabilityCommand["capability"];
}

const { Identify, Groups, OnOff, LevelControl, ScenesManagement, ColorControl, WindowCovering, OccupancySensing } =
  Object.fromEntries(Object.entries(MatterClusterId).map(([k, v]) => [k, cluster(v)])) as Record<
    keyof typeof MatterClusterId,
    MatterClusterRequirement
  >;

/**
 * Phase 1's supported Matter Device Types — On/Off Light, Dimmable Light, Color Temperature
 * Light, Extended Color Light, and Window Covering, exactly the set the Matter Bridge bug
 * report needed (colour-temperature lights and a curtain motor were being silently skipped).
 * Sensors, locks, thermostats, switches, energy, and media device types are explicitly OUT of
 * scope for Phase 1 (§ Phase 2-4) — a SupremeOS device whose capabilities don't resolve to one
 * of these five is reported UNSUPPORTED by the resolver, never silently dropped nor forced into
 * a device type it doesn't actually conform to.
 */
export const MATTER_DEVICE_TYPES: MatterDeviceTypeDefinition[] = [
  {
    id: 0x0100,
    name: "On/Off Light",
    revision: 3,
    requiredServerClusters: [Identify, Groups, OnOff, ScenesManagement],
    optionalServerClusters: [LevelControl, OccupancySensing],
    primaryCapability: "onoff",
  },
  {
    id: 0x0101,
    name: "Dimmable Light",
    revision: 3,
    requiredServerClusters: [Identify, Groups, OnOff, LevelControl, ScenesManagement],
    optionalServerClusters: [OccupancySensing],
    primaryCapability: "brightness",
  },
  {
    id: 0x010c,
    name: "Color Temperature Light",
    revision: 4,
    requiredServerClusters: [Identify, Groups, OnOff, LevelControl, ScenesManagement, ColorControl],
    optionalServerClusters: [OccupancySensing],
    primaryCapability: "color",
  },
  {
    id: 0x010d,
    name: "Extended Color Light",
    revision: 4,
    requiredServerClusters: [Identify, Groups, OnOff, LevelControl, ScenesManagement, ColorControl],
    optionalServerClusters: [OccupancySensing],
    primaryCapability: "color",
  },
  {
    id: 0x0202,
    name: "Window Covering",
    revision: 6,
    requiredServerClusters: [Identify, WindowCovering],
    optionalServerClusters: [Groups],
    primaryCapability: "position",
  },
];
