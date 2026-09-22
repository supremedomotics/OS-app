/**
 * (§ Matter Controller Extension, Phase 3 — Generic Cluster Engine)
 *
 * A single, consistent error model for every generic Matter Controller operation
 * (target resolution, read, write, invoke). Never swallows the underlying `@matter/main`
 * error — always attached as `cause` — but never lets raw fabric/session internals leak
 * into a message string (§ requirement 9/13: no PASE/CASE material, no NOCs, no keys).
 */

export type MatterEngineErrorReason =
  /** No persisted device-interview model exists for this node id at all. */
  | "node_not_commissioned"
  /** The node is commissioned (a model exists) but is not currently a live fabric peer. */
  | "node_not_found"
  | "endpoint_not_found"
  | "cluster_not_found"
  | "attribute_not_found"
  | "command_not_found"
  /** The cluster/endpoint exists in the model but the live behavior is not active
   * (crashed, not yet initialized) — distinct from "not found" (§ requirement 4). */
  | "unavailable"
  /** A real `@matter/main`/Matter protocol error surfaced during the live operation
   * (timeout, StatusResponse failure, session error, etc.). */
  | "runtime_error";

export interface MatterEngineErrorContext {
  operation: "read" | "write" | "invoke" | "resolve";
  nodeId: string;
  endpointId?: number;
  clusterId?: number;
  attributeId?: number;
  commandId?: number;
}

/** Thrown by every generic engine operation on failure — preserves enough structured
 * context for diagnostics to name the exact node/endpoint/cluster/attribute-or-command
 * and operation that failed, without ever including credential material (§ requirement 13). */
export class MatterEngineError extends Error {
  readonly reason: MatterEngineErrorReason;
  readonly context: MatterEngineErrorContext;

  constructor(reason: MatterEngineErrorReason, context: MatterEngineErrorContext, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "MatterEngineError";
    this.reason = reason;
    this.context = context;
  }
}
