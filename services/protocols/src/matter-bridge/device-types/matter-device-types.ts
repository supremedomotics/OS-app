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
  /** § Phase 1 bridge-direction only — see doc comment above. `null` for a device type with no
   * SupremeOS *capability* equivalent at all (§ Matter Bridge Phase 2B — Generic Switch is an
   * INPUT device: it has no `CapabilityState`/`CapabilityCommand`, only Universal Input Events,
   * so there is no capability for this field to name). Every existing capability-driven device
   * type keeps a real, non-null value — this only widens the type, it changes nothing for them. */
  primaryCapability: CapabilityCommand["capability"] | null;
}

const { Identify, Groups, OnOff, LevelControl, ScenesManagement, ColorControl, WindowCovering, OccupancySensing, Switch } =
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
    // § Matter Bridge Phase 2A — On/Off Plug-in Unit (0x010A / 266), transcribed directly from
    // `@matter/node`'s generated `devices/on-off-plug-in-unit.js`: required server clusters are
    // Identify/Groups/OnOff/ScenesManagement — STRUCTURALLY IDENTICAL to On/Off Light's cluster
    // set (0x0100). The two device types exist purely to tell a controller (Apple/Google/Alexa)
    // "this is a switched outlet" vs "this is a light" for icon/category purposes — Matter's own
    // spec has no capability-level distinction between them, so SupremeOS's own
    // `device.supremeType` ("switch" vs "light") is the ONLY honest signal that can pick one over
    // the other (see `matter-device-type-resolver.ts`'s `resolveMatterDeviceType` — never a
    // capability-only guess, and never a protocol-specific check).
    id: 0x010a,
    name: "On/Off Plug-in Unit",
    revision: 4,
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
  {
    // § Matter Bridge Phase 2B — Generic Switch (0x000F / 15), transcribed directly from
    // `@matter/node`'s generated `devices/generic-switch.js`: required server clusters are only
    // Identify + Switch. `primaryCapability: null` — this is an INPUT device (Universal Input
    // Events, not a `CapabilityState`), resolved through its own separate path
    // (`resolveKeypadControlDeviceType` in `matter-device-type-resolver.ts`), never through
    // `resolveMatterDeviceType`'s `DeviceCapability[]`-driven resolution. One endpoint = one
    // physical control (button) — a multi-button keypad becomes multiple Generic Switch
    // endpoints, the same "one SupremeOS thing = one Matter endpoint" pattern every other device
    // type here already uses, just applied per-control instead of per-device (§ endpoint
    // architecture doc, `matter-bridge-driver.ts`'s `exposeKeypadButton`).
    id: 0x000f,
    name: "Generic Switch",
    revision: 3,
    requiredServerClusters: [Identify, Switch],
    optionalServerClusters: [],
    primaryCapability: null,
  },
];
