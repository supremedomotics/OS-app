/**
 * Matter cluster identifiers (§ Matter Bridge Phase 1 foundation). Taken verbatim from
 * `@matter/types`'s own generated cluster definitions (`@matter/types/clusters/*`) — themselves
 * generated from the official Matter 1.6 specification — never hand-guessed or copied from a
 * third-party mapping. This is the ONE place a cluster id is named; every device-type
 * definition and cluster adapter in this directory references these constants rather than
 * repeating a raw hex literal.
 */
export const MatterClusterId = {
  Identify: 0x0003,
  Groups: 0x0004,
  OnOff: 0x0006,
  LevelControl: 0x0008,
  ScenesManagement: 0x0062,
  ColorControl: 0x0300,
  WindowCovering: 0x0102,
  OccupancySensing: 0x0406,
  Switch: 0x003b,
  /** § Matter Bridge Phase 3.2 — CoolMaster Thermostat. Verified against `@matter/types`'s
   * generated `clusters/thermostat.d.ts`. */
  Thermostat: 0x0201,
} as const;
export type MatterClusterId = (typeof MatterClusterId)[keyof typeof MatterClusterId];

export const MatterClusterName: Record<number, string> = Object.fromEntries(
  Object.entries(MatterClusterId).map(([name, id]) => [id, name]),
);
