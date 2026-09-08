import { MatterClusterId } from "../device-types/matter-cluster-ids.js";
import type { MatterClusterAdapter } from "./matter-cluster-adapter.js";

export const OnOffAdapter: MatterClusterAdapter = { clusterId: MatterClusterId.OnOff, clusterName: "OnOff" };

/** SupremeOS `on` -> the Matter OnOff cluster's OnOff attribute (identical booleans — the only
 * cluster with no real unit/scale conversion, kept as its own adapter for symmetry with every
 * other cluster and so `real-server.ts` never special-cases OnOff as "the one with no adapter"). */
export function onOffToMatter(on: boolean): boolean {
  return on;
}

/** A genuine Matter OnOff command -> the SupremeOS onoff action. */
export function onOffFromMatter(on: boolean): "on" | "off" {
  return on ? "on" : "off";
}
