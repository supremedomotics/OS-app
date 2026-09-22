/**
 * (§ Matter Controller Extension, Phase 2 — Device Interview)
 *
 * The controller-side internal Matter device model. This is the "what did we actually
 * learn about this node from the real Matter stack" record — deliberately separate from
 * SupremeOS capability mapping (`../matter-codec.ts`, still Phase 3/4's job) and from the
 * Matter Bridge's own outbound device model (`../matter-bridge/device-types/*`), which
 * describes SupremeOS devices being EXPOSED as Matter, not third-party Matter devices
 * being UNDERSTOOD. Populated by `./discovery.ts`, persisted by `./persistence.ts`.
 */

/** Stable identity for a Matter endpoint — never a display name, IP, or MAC, and never
 * regenerated on rediscovery (§ requirement 2). */
export function matterEndpointIdentity(nodeId: string, endpointId: number): string {
  return `matter://node/${nodeId}/endpoint/${endpointId}`;
}

/** A Matter Device Type as declared by the endpoint's real Descriptor.DeviceTypeList entry.
 * `name` is `null` for a device type SupremeOS doesn't (yet) recognize — the numeric id and
 * revision are ALWAYS preserved regardless (§ requirement 5 — never discard an unknown
 * device type, never invent a friendly name for it). */
export interface ResolvedDeviceType {
  deviceType: number;
  revision: number;
  name: string | null;
}

/** One cluster on one endpoint, as reported by the endpoint's real Descriptor ServerList/
 * ClientList (direction) enriched with whatever runtime metadata the local `@matter/main`
 * client stack has loaded for that cluster (§ requirement 6 — runtime metadata preferred
 * over a hard-coded table). `name`/`attributes`/`commands`/`events`/`features` are empty/
 * null when the local stack has no client behavior for this cluster id at all — the
 * cluster is still recorded by numeric id, never dropped (§ requirement 6 — unknown
 * clusters remain discoverable by numeric id). */
export interface MatterClusterInfo {
  clusterId: number;
  name: string | null;
  direction: "server" | "client";
  attributes: string[];
  commands: string[];
  events: string[];
  features: string[];
}

export interface MatterEndpointModel {
  endpointId: number;
  identity: string;
  /** Real Descriptor.DeviceTypeList — usually one entry, occasionally more (composed device). */
  deviceTypes: ResolvedDeviceType[];
  /** Real Descriptor.PartsList — child endpoint numbers under this one (§ requirement 4). */
  partsList: number[];
  serverClusters: MatterClusterInfo[];
  clientClusters: MatterClusterInfo[];
}

export type MatterInterviewState = "pending" | "interviewing" | "complete" | "failed";

export interface MatterNodeModel {
  nodeId: string;
  vendorId: number | null;
  productId: number | null;
  softwareVersion: number | null;
  hardwareVersion: number | null;
  vendorName: string | null;
  productName: string | null;
  reachable: boolean;
  lastSeenAt: string | null;
  interviewState: MatterInterviewState;
  lastInterviewError: string | null;
  /** Includes endpoint 0 (root) — callers that must not treat the root as a user-facing
   * device (§ requirement 4) filter it out themselves; the model records the whole truth. */
  endpoints: MatterEndpointModel[];
}
