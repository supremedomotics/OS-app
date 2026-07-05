import type { FleetHubList } from "@supreme/contracts";

/**
 * Minimal client for the OPTIONAL cloud Fleet API. Configured separately from the
 * hub (different service, org API key). When unconfigured, the Fleet page shows a
 * setup hint rather than failing — the hub works without fleet management.
 */
const fleetUrl = (import.meta.env.VITE_SUPREME_FLEET_URL ?? "").replace(/\/$/, "");
const fleetKey = import.meta.env.VITE_SUPREME_FLEET_KEY ?? "";

export const fleetConfigured = Boolean(fleetUrl && fleetKey);

export async function listFleetHubs(): Promise<FleetHubList> {
  const res = await fetch(`${fleetUrl}/v1/fleet/hubs`, {
    headers: { authorization: `Bearer ${fleetKey}` },
  });
  if (!res.ok) throw new Error(`fleet request failed (${res.status})`);
  return (await res.json()) as FleetHubList;
}
