/**
 * (§ Matter Controller Extension, Phase 3 — Generic Cluster Engine)
 *
 * The single generic target-resolution layer (§ requirement 4) — every read/write/invoke
 * operation resolves its target through here, never duplicating endpoint/cluster lookup
 * logic. Resolution is against the REAL live `ClientNode` (§ requirement 11 — the Phase 2
 * interviewed `MatterNodeModel` is identity/diagnostics only, never the live connection);
 * the model is used solely to distinguish "never commissioned" from "commissioned but not
 * currently a live peer" for a clearer error (§ requirement 4/13).
 */
import type { ClientNode, Behavior } from "@matter/main";
import type { MatterNodeModel } from "./device-model.js";
import { MatterEngineError, type MatterEngineErrorContext } from "./errors.js";

export interface ResolvedTarget {
  endpoint: ReturnType<ClientNode["endpoints"]["for"]>;
  /** The real, loaded `Behavior.Type` for this cluster on this endpoint. */
  type: Behavior.Type;
}

/** Resolve `endpointId` + `clusterId` against a live `ClientNode`. Never resolves attribute
 * or command identity itself — see `resolveAttribute`/`resolveCommand` below, kept separate
 * so read/write share this exact same endpoint+cluster resolution as invoke. */
export function resolveEndpointAndCluster(
  node: ClientNode | undefined,
  model: MatterNodeModel | undefined,
  nodeId: string,
  endpointId: number,
  cluster: number | string,
  operation: MatterEngineErrorContext["operation"],
): ResolvedTarget {
  const clusterId = typeof cluster === "number" ? cluster : undefined;
  const ctx: MatterEngineErrorContext = { operation, nodeId, endpointId, clusterId };

  if (!model) {
    throw new MatterEngineError("node_not_commissioned", ctx, `matter-controller: node ${nodeId} has no persisted device model — never commissioned`);
  }
  if (!node) {
    throw new MatterEngineError("node_not_found", ctx, `matter-controller: node ${nodeId} is commissioned but not currently a live fabric peer`);
  }

  if (!node.endpoints.has(endpointId)) {
    throw new MatterEngineError("endpoint_not_found", ctx, `matter-controller: node ${nodeId} has no endpoint ${endpointId}`);
  }
  const endpoint = node.endpoints.for(endpointId);

  const type =
    typeof cluster === "number"
      ? endpoint.behaviors.active.find((t) => (t as { cluster?: { id?: number } }).cluster?.id === cluster)
      : endpoint.behaviors.active.find((t) => t.id.toLowerCase() === cluster.toLowerCase());
  if (!type) {
    // Distinguish "the model never saw this cluster on this endpoint at all" (cluster_not_found)
    // from "the model saw it in Descriptor.serverList but the local behavior never activated"
    // (unavailable) — both real, distinct diagnoses (§ requirement 4).
    const modelEndpoint = model.endpoints.find((e) => e.endpointId === endpointId);
    const knownInModel =
      typeof cluster === "number"
        ? modelEndpoint?.serverClusters.some((c) => c.clusterId === cluster)
        : modelEndpoint?.serverClusters.some((c) => c.name?.toLowerCase() === cluster.toLowerCase());
    if (knownInModel) {
      throw new MatterEngineError(
        "unavailable",
        ctx,
        `matter-controller: cluster ${cluster} on node ${nodeId} endpoint ${endpointId} is known but not currently active`,
      );
    }
    throw new MatterEngineError("cluster_not_found", ctx, `matter-controller: node ${nodeId} endpoint ${endpointId} has no cluster ${cluster}`);
  }

  return { endpoint, type };
}

/** Resolve an attribute by numeric id OR real runtime name to its canonical name
 * (§ requirement 6 — generic metadata, never a hard-coded per-device-type attribute table).
 * Numeric id is the primary Phase 3 identity; name lookup exists only so
 * `MatterProtocolDriver`'s existing string-cluster-name command contract (§ requirement 5)
 * can reuse this SAME resolver rather than a second lookup path. */
export function resolveAttribute(
  resolved: ResolvedTarget,
  attribute: number | string,
  ctx: MatterEngineErrorContext,
): { name: string; id: number } {
  const attributes = (resolved.type as { cluster?: { attributes?: Record<string, { id: number }> } }).cluster?.attributes ?? {};
  const entry =
    typeof attribute === "number"
      ? Object.entries(attributes).find(([, a]) => a.id === attribute)
      : Object.entries(attributes).find(([name]) => name.toLowerCase() === attribute.toLowerCase());
  if (!entry) {
    throw new MatterEngineError(
      "attribute_not_found",
      ctx,
      `matter-controller: cluster ${ctx.clusterId} on node ${ctx.nodeId} endpoint ${ctx.endpointId} has no attribute ${attribute}`,
    );
  }
  return { name: entry[0], id: entry[1].id };
}

/** Resolve a command by numeric id OR real runtime name to its canonical method name
 * (§ requirement 6). See `resolveAttribute`'s doc comment for why both forms are supported. */
export function resolveCommand(
  resolved: ResolvedTarget,
  command: number | string,
  ctx: MatterEngineErrorContext,
): { name: string; id: number } {
  const commands = (resolved.type as { cluster?: { commands?: Record<string, { id: number }> } }).cluster?.commands ?? {};
  const entry =
    typeof command === "number"
      ? Object.entries(commands).find(([, c]) => c.id === command)
      : Object.entries(commands).find(([name]) => name.toLowerCase() === command.toLowerCase());
  if (!entry) {
    throw new MatterEngineError(
      "command_not_found",
      ctx,
      `matter-controller: cluster ${ctx.clusterId} on node ${ctx.nodeId} endpoint ${ctx.endpointId} has no command ${command}`,
    );
  }
  return { name: entry[0], id: entry[1].id };
}
