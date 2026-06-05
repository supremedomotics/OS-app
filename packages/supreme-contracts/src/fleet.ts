import { z } from "zod";

/**
 * Cloud fleet API contracts (§13, §16) — OPTIONAL installer fleet management. A hub
 * never depends on this for in-home function; it lets an installer org oversee many
 * homes/hubs. Authenticated per-org (an API key maps to an org).
 */
export const RegisterHubRequest = z.object({
  homeId: z.string(),
  name: z.string().min(1),
  version: z.string(),
});
export type RegisterHubRequest = z.infer<typeof RegisterHubRequest>;

export const FleetHeartbeatRequest = z.object({ version: z.string().optional() });
export type FleetHeartbeatRequest = z.infer<typeof FleetHeartbeatRequest>;

export const FleetHub = z.object({
  id: z.string(),
  orgId: z.string(),
  homeId: z.string(),
  name: z.string(),
  version: z.string(),
  registeredAt: z.string(),
  lastSeenAt: z.string(),
  status: z.enum(["online", "offline"]),
});
export type FleetHub = z.infer<typeof FleetHub>;

export const FleetHubResponse = z.object({ hub: FleetHub.omit({ status: true }) });
export type FleetHubResponse = z.infer<typeof FleetHubResponse>;

export const FleetHubList = z.object({ hubs: z.array(FleetHub) });
export type FleetHubList = z.infer<typeof FleetHubList>;
