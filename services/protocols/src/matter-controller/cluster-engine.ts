/**
 * (§ Matter Controller Extension, Phase 3 — Generic Cluster Engine)
 *
 * Generic Matter attribute read/write and command invocation, addressed by numeric
 * endpoint/cluster/attribute/command id (primary Phase 3 identity) or by real runtime NAME
 * (accepted too, only so `MatterProtocolDriver`'s existing string-cluster-name command
 * contract — § requirement 5 — can reuse this SAME engine instead of a second one). Never a
 * `if (deviceType === "light")` branch anywhere in this file. Operates against the REAL,
 * live `ClientNode` via `@matter/main`'s own `Agent`/behavior-state API — the same
 * mechanism matter.js's own controller examples use for a live peer: reading/writing a
 * `ClientNode`'s behavior state transparently performs the real over-the-wire Matter
 * interaction; there is no separate low-level protocol-request path to hand-build here.
 *
 * The Phase 2 interviewed `MatterNodeModel` is never treated as the live connection
 * (§ requirement 11) — it is passed in only for `target-resolver.ts`'s "never commissioned"
 * vs "not currently reachable" diagnosis. Every actual read/write/invoke resolves against
 * the live `ClientNode` passed in by the caller (`real-controller.ts`).
 */
import type { ClientNode } from "@matter/main";
import type { MatterNodeModel } from "./device-model.js";
import { MatterEngineError, type MatterEngineErrorContext } from "./errors.js";
import { resolveAttribute, resolveCommand, resolveEndpointAndCluster } from "./target-resolver.js";

export interface MatterReadResult {
  nodeId: string;
  endpointId: number;
  clusterId: number;
  attributeId: number;
  attributeName: string;
  value: unknown;
  timestamp: string;
}

export interface MatterWriteResult {
  nodeId: string;
  endpointId: number;
  clusterId: number;
  attributeId: number;
  attributeName: string;
  value: unknown;
  timestamp: string;
}

export interface MatterInvokeResult {
  nodeId: string;
  endpointId: number;
  clusterId: number;
  commandId: number;
  commandName: string;
  response: unknown;
  timestamp: string;
}

/** Wraps a real `@matter/main` call so an underlying protocol failure (timeout, status
 * error, session error) surfaces as a `MatterEngineError` with full context rather than a
 * bare, context-free rejection (§ requirement 13 — never silently swallowed). */
async function runLive<T>(operation: () => Promise<T>, ctx: MatterEngineErrorContext): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof MatterEngineError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new MatterEngineError("runtime_error", ctx, `matter-controller: Matter runtime error during ${ctx.operation} — ${message}`, err);
  }
}

function clusterIdOf(type: unknown): number {
  return (type as { cluster?: { id?: number } }).cluster?.id ?? -1;
}

export async function readAttribute(
  node: ClientNode | undefined,
  model: MatterNodeModel | undefined,
  nodeId: string,
  endpointId: number,
  cluster: number | string,
  attribute: number | string,
): Promise<MatterReadResult> {
  const resolved = resolveEndpointAndCluster(node, model, nodeId, endpointId, cluster, "read");
  const clusterId = clusterIdOf(resolved.type);
  const ctx: MatterEngineErrorContext = { operation: "read", nodeId, endpointId, clusterId };
  const { name, id: attributeId } = resolveAttribute(resolved, attribute, ctx);

  const value = await runLive(async () => {
    // § `Endpoint.stateOf()` only returns the LOCAL mirrored cache (no subscription is
    // established — § requirement per `real-controller.ts`'s `subscribe()` being Phase 4, not
    // yet implemented), so it would silently return a stale pre-invoke value. `getStateOf()` is
    // `@matter/node`'s own real forced-remote-read API (see `Endpoint.js#getStateOf` →
    // `#performRead()` → `node.interaction.read()`) — a genuine over-the-wire attribute read.
    const state = (await resolved.endpoint.getStateOf(resolved.type.id, [name])) as Record<string, unknown>;
    return state[name];
  }, { ...ctx, attributeId });

  return { nodeId, endpointId, clusterId, attributeId, attributeName: name, value, timestamp: new Date().toISOString() };
}

export async function writeAttribute(
  node: ClientNode | undefined,
  model: MatterNodeModel | undefined,
  nodeId: string,
  endpointId: number,
  cluster: number | string,
  attribute: number | string,
  value: unknown,
): Promise<MatterWriteResult> {
  const resolved = resolveEndpointAndCluster(node, model, nodeId, endpointId, cluster, "write");
  const clusterId = clusterIdOf(resolved.type);
  const ctx: MatterEngineErrorContext = { operation: "write", nodeId, endpointId, clusterId };
  const { name, id: attributeId } = resolveAttribute(resolved, attribute, ctx);
  const writeCtx = { ...ctx, attributeId };

  await runLive(async () => {
    // § real remote write — `Endpoint.act()` performs the actual over-the-wire Matter
    // interaction for a peer's cluster state, not a local mutation (matches matter.js's own
    // documented controller usage pattern). `@matter/main` itself validates the value against
    // the cluster's real schema/constraints during this call — never re-implemented here.
    // Must act() on `resolved.endpoint`, NOT `node`: `Endpoint.act()` binds the callback's
    // `agent` to the endpoint it's called on (see `Endpoint.js#act` → `this.agentFor(context)`),
    // so `node!.act()` would hand back an agent for the ROOT endpoint — `agent.get()` would then
    // reject every non-root-endpoint cluster type as "Unsupported behavior" even though
    // `target-resolver.ts` resolved it correctly.
    await resolved.endpoint.act((agent) => {
      const instance = agent.get(resolved.type) as unknown as Record<string, unknown>;
      (instance.state as Record<string, unknown>)[name] = value;
    });
  }, writeCtx);

  const after = ((await resolved.endpoint.getStateOf(resolved.type.id, [name])) as Record<string, unknown>)[name];
  return { nodeId, endpointId, clusterId, attributeId, attributeName: name, value: after, timestamp: new Date().toISOString() };
}

export async function invokeCommand(
  node: ClientNode | undefined,
  model: MatterNodeModel | undefined,
  nodeId: string,
  endpointId: number,
  cluster: number | string,
  command: number | string,
  fields: Record<string, unknown> = {},
): Promise<MatterInvokeResult> {
  const resolved = resolveEndpointAndCluster(node, model, nodeId, endpointId, cluster, "invoke");
  const clusterId = clusterIdOf(resolved.type);
  const ctx: MatterEngineErrorContext = { operation: "invoke", nodeId, endpointId, clusterId };
  const { name, id: commandId } = resolveCommand(resolved, command, ctx);
  const invokeCtx = { ...ctx, commandId };

  const response = await runLive(async () => {
    // § see the write-path note above — must act() on `resolved.endpoint`, not `node`, or
    // `agent.get()` resolves against the root endpoint and rejects the real cluster type.
    return resolved.endpoint.act((agent) => {
      const instance = agent.get(resolved.type) as unknown as Record<string, (arg?: unknown) => unknown>;
      const method = instance[name];
      if (typeof method !== "function") {
        throw new MatterEngineError(
          "command_not_found",
          invokeCtx,
          `matter-controller: command ${name} (${commandId}) on cluster ${clusterId} is not invocable on this endpoint`,
        );
      }
      // § a no-argument command's generated client method (e.g. OnOff's `on()`/`off()`) takes
      // no parameter at all — its TLV request schema is `NoArgumentsSchema` (void). Calling it
      // with an empty `{}` (this function's own default) fails real validation with
      // "Expected void, got object", so an empty `fields` must be passed as no argument.
      return Object.keys(fields).length ? method.call(instance, fields) : method.call(instance);
    });
  }, invokeCtx);

  return { nodeId, endpointId, clusterId, commandId, commandName: name, response, timestamp: new Date().toISOString() };
}
