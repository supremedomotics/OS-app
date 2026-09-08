import { MatterClusterId } from "../device-types/matter-cluster-ids.js";
import type { MatterClusterAdapter } from "./matter-cluster-adapter.js";

export const WindowCoveringAdapter: MatterClusterAdapter = { clusterId: MatterClusterId.WindowCovering, clusterName: "WindowCovering" };

/**
 * Position scale is SPEC-INVERTED between the two models — get this backwards and every open/
 * close reads as its opposite on a real controller. SupremeOS's `position` capability: 0 = fully
 * closed, 100 = fully open (`PositionState`'s own doc comment, `packages/domain-model/src/
 * capabilities.ts`). Matter's WindowCovering CurrentPositionLiftPercentage /
 * *LiftPercent100ths: 0% = fully OPEN, 100% = fully CLOSED — the standard Matter/ZCL window-
 * covering convention (verified against `@matter/node`'s `WindowCoveringServer.ts` and the
 * cluster's own spec). `*Percent100ths` is the percentage scaled by 100 (0..10000) for
 * sub-percent resolution.
 */
const MATTER_PERCENT100THS_SCALE = 100;

/** SupremeOS position percent (0=closed, 100=open) -> Matter *LiftPercent100ths (0=open, 10000=closed). */
export function positionToMatterPercent100ths(supremePosition: number): number {
  const clamped = Math.max(0, Math.min(100, supremePosition));
  return Math.round((100 - clamped) * MATTER_PERCENT100THS_SCALE);
}

/** Matter *LiftPercent100ths (0=open, 10000=closed) -> SupremeOS position percent (0=closed, 100=open). */
export function positionFromMatterPercent100ths(percent100ths: number): number {
  const matterPercent = percent100ths / MATTER_PERCENT100THS_SCALE;
  return Math.max(0, Math.min(100, Math.round(100 - matterPercent)));
}
