import { MatterClusterId } from "../device-types/matter-cluster-ids.js";
import type { MatterClusterAdapter } from "./matter-cluster-adapter.js";

export const LevelControlAdapter: MatterClusterAdapter = { clusterId: MatterClusterId.LevelControl, clusterName: "LevelControl" };

/** Per the Lighting device types' own `currentLevel: {min:1, max:254}` attribute alteration
 * (verified against `@matter/node`'s generated `dimmable-light.ts`/`color-temperature-light.ts`/
 * `extended-color-light.ts` — the Matter 1.6 Lighting device types never allow CurrentLevel=0,
 * unlike LevelControl's own base range which permits it for non-lighting devices). */
const MATTER_LEVEL_MIN = 1;
const MATTER_LEVEL_MAX = 254;

/** SupremeOS brightness percent (0-100) -> Matter LevelControl's CurrentLevel (1-254). */
export function levelToMatter(percent: number): number {
  return Math.max(MATTER_LEVEL_MIN, Math.min(MATTER_LEVEL_MAX, Math.round((percent / 100) * MATTER_LEVEL_MAX)));
}

/** Matter CurrentLevel (1-254) -> SupremeOS brightness percent (0-100). */
export function levelFromMatter(level: number): number {
  return Math.max(0, Math.min(100, Math.round((level / MATTER_LEVEL_MAX) * 100)));
}
