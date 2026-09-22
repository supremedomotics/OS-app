/**
 * (§ Matter Controller Extension, Phase 2 — Device Interview)
 *
 * The real device-interview engine: commissioned `ClientNode` -> endpoint enumeration ->
 * Descriptor discovery -> device type resolution -> cluster inventory -> `MatterNodeModel`
 * (`./device-model.ts`). Deliberately separate from command execution (Phase 3's generic
 * cluster engine), capability mapping (`../matter-codec.ts`, Phase 3/4), and persistence
 * (`./persistence.ts`) — this module only reads what the real `@matter/main` client stack
 * already knows about a peer node and shapes it into SupremeOS's own model. No mocks: every
 * field here comes from a real `ClientNode`'s real behavior state.
 */
import { DescriptorBehavior } from "@matter/main/behaviors/descriptor";
import { BasicInformationBehavior } from "@matter/main/behaviors/basic-information";
import type { ClientNode } from "@matter/main";
import { resolveDeviceType } from "./device-type-resolver.js";
import {
  matterEndpointIdentity,
  type MatterClusterInfo,
  type MatterEndpointModel,
  type MatterNodeModel,
} from "./device-model.js";

export interface InterviewLog {
  (level: "info" | "warn" | "error", message: string): void;
}

/**
 * Interview one endpoint's real Descriptor + active cluster behaviors. Never throws for a
 * single missing/unsupported piece of data — a cluster the local client stack hasn't loaded
 * is recorded by numeric id only (§ requirement 3 — do not fabricate unsupported values).
 */
function interviewEndpoint(node: ClientNode, endpointId: number, onLog?: InterviewLog): MatterEndpointModel | null {
  const endpoint = node.endpoints.for(endpointId);
  if (!endpoint.behaviors.has(DescriptorBehavior)) {
    onLog?.(
      "warn",
      `matter-controller: endpoint ${endpointId} on node ${node.id} has no Descriptor — skipping (spec violation, not fabricated)`,
    );
    return null;
  }
  const descriptor = endpoint.stateOf(DescriptorBehavior);
  const deviceTypes = descriptor.deviceTypeList.map((dt) => resolveDeviceType(dt.deviceType, dt.revision));
  const partsList = [...descriptor.partsList];

  // Real runtime metadata (§ requirement 6) — every ClusterBehavior the local client stack has
  // actually loaded for this endpoint, keyed by its real numeric cluster id.
  const activeByClusterId = new Map<number, (typeof endpoint.behaviors.active)[number]>();
  for (const type of endpoint.behaviors.active) {
    const clusterId = (type as { cluster?: { id?: number } }).cluster?.id;
    if (clusterId !== undefined) activeByClusterId.set(clusterId, type);
  }

  const buildCluster = (clusterId: number, direction: "server" | "client"): MatterClusterInfo => {
    const type = activeByClusterId.get(clusterId);
    if (!type) {
      // Unknown/unimplemented-by-local-stack cluster — preserved by numeric id only,
      // never dropped, never given fabricated attributes/commands/events (§ requirement 6).
      return { clusterId, name: null, direction, attributes: [], commands: [], events: [], features: [] };
    }
    const elements = endpoint.behaviors.elementsOf(type);
    return {
      clusterId,
      name: type.id,
      direction,
      attributes: [...elements.attributes],
      commands: [...elements.commands],
      events: [...elements.events],
      features: [...elements.features],
    };
  };

  return {
    endpointId,
    identity: matterEndpointIdentity(node.id, endpointId),
    deviceTypes,
    partsList,
    serverClusters: [...descriptor.serverList].map((id) => buildCluster(id, "server")),
    clientClusters: [...descriptor.clientList].map((id) => buildCluster(id, "client")),
  };
}

/**
 * Interview a full commissioned node: every endpoint the node's real Descriptor structure
 * reports (§ requirement 4 — endpoint 0/root is included in the model, never silently
 * exposed as a device; that filtering is the CALLER's job, e.g. `discover()` integration).
 * Basic Information (vendor/product/software/hardware) is read from the root endpoint's real
 * BasicInformation cluster when the local stack has loaded it — never fabricated when absent.
 */
export function interviewNode(node: ClientNode, onLog?: InterviewLog): MatterNodeModel {
  const endpoints: MatterEndpointModel[] = [];
  for (const ep of node.endpoints) {
    const model = interviewEndpoint(node, ep.number, onLog);
    if (model) endpoints.push(model);
  }

  const root = node.endpoints.for(0);
  const basic = root.behaviors.has(BasicInformationBehavior) ? root.stateOf(BasicInformationBehavior) : undefined;

  return {
    nodeId: node.id,
    vendorId: basic?.vendorId ?? null,
    productId: basic?.productId ?? null,
    softwareVersion: basic?.softwareVersion ?? null,
    hardwareVersion: basic?.hardwareVersion ?? null,
    vendorName: basic?.vendorName ?? null,
    productName: basic?.productName ?? null,
    reachable: true,
    lastSeenAt: new Date().toISOString(),
    interviewState: "complete",
    lastInterviewError: null,
    endpoints,
  };
}
