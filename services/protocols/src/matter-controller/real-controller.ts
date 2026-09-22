/**
 * (§ Matter Controller Extension — Phase 1 Controller Foundation, Phase 2 Device Interview)
 *
 * Real `@matter/main`-backed implementation of the `MatterController` transport seam
 * declared in `../matter-driver.ts`. This is the INBOUND direction — SupremeOS acting as
 * a Matter controller/commissioner that onboards third-party Matter devices onto its own
 * fabric — and is entirely separate from `../matter-bridge/` (SupremeOS's OUTBOUND Matter
 * bridge, which exposes Supreme devices as a Matter aggregator to other ecosystems). The
 * two share no fabric state, no storage root, and no lifecycle: each owns a fresh
 * `Environment`/`storagePath` pair, mirroring the isolation pattern already proven in
 * `matter-bridge/real-server.ts` (a shared `Environment.default` there once leaked
 * storage/endpoint state across instances).
 *
 * Phase 1 scope: controller lifecycle, persistent fabric storage, commissioning.
 * Phase 2 scope (this file, extended): after commissioning AND on every reconnect, run the
 * real device-interview engine (`./discovery.ts`) against the live `ClientNode` and persist
 * the result (`./persistence.ts`), tracking commissioning and interview as SEPARATE states
 * (§ requirement 8) — a temporarily unreachable device is `interviewState: "failed"`, not a
 * permanently broken commission.
 *
 * Generic cluster read/write/invoke/subscribe (the piece `command()`/`onState()` on
 * `MatterProtocolDriver` need to actually drive a commissioned device) remains Phase 3's
 * "generic cluster engine" — deliberately NOT faked here. `invoke`/`subscribe` throw a
 * clear, typed "not yet implemented" error rather than pretending to control a device.
 */
import { Environment, ServerNode, Logger, LogLevel, Seconds, ControllerBehavior } from "@matter/main";
import type { ClientNode } from "@matter/main";
import type {
  MatterAddress,
  MatterAttributeReport,
  MatterController,
  MatterNodeInfo,
} from "../matter-driver.js";
import type { MatterOnboardingPayload } from "../matter-pairing.js";
import { interviewNode } from "./discovery.js";
import type { MatterNodeModel } from "./device-model.js";
import {
  FileMatterDeviceModelStore,
  InMemoryMatterDeviceModelStore,
  type MatterDeviceModelStore,
} from "./persistence.js";
import {
  invokeCommand as engineInvokeCommand,
  readAttribute as engineReadAttribute,
  writeAttribute as engineWriteAttribute,
  type MatterInvokeResult,
  type MatterReadResult,
  type MatterWriteResult,
} from "./cluster-engine.js";

export interface RealMatterControllerOptions {
  /** Filesystem root for this controller's OWN fabric/credential storage. Must never be
   * the same path as the Matter Bridge's `storagePath` (§ requirement 6 — controller and
   * bridge must not share fabric state). */
  storagePath?: string;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /** Injectable device-model store (tests use an in-memory one); defaults to a JSON file
   * under `storagePath` when one is given, else in-memory only (§ requirement 10 — kept
   * separate from Bridge storage and from `@matter/main`'s own fabric storage). */
  deviceModelStore?: MatterDeviceModelStore;
  /** Override the operational UDP port (default: `@matter/main`'s standard 5540). Tests use
   * this to avoid colliding with a leaked process from an earlier interrupted run — never
   * set in production, where the standard port is what makes the controller discoverable. */
  port?: number;
  /** Override the controller's own local node id (default: `supreme-matter-controller`).
   * Production always runs a single controller per hub, so the fixed default is correct
   * there; tests that create multiple `RealMatterController` instances in one process need
   * distinct ids — reusing the same id for a second live instance in the same process hit a
   * real `@matter/general` "SessionManager unavailable ... groupDataCounter" crash (global
   * environment-keyed state collision), not a SupremeOS logic bug. */
  nodeId?: string;
  /** Override the commissioning discovery+PASE wall-clock budget (default: `@matter/main`'s
   * own, ~30s). Production leaves this unset — a real device commissioning over Wi-Fi/Thread
   * can legitimately take longer than a short test budget. Tests use a short bound so a
   * flaky-discovery attempt fails fast enough for a bounded retry loop to matter. */
  commissionTimeoutSeconds?: number;
}

/** Stable local node id for the hub's own controller identity.
 * ponytail: single-instance only (one controller per hub) — multi-fabric/multi-instance
 * controllers would need a caller-supplied id, add when a second Matter fabric per hub
 * is actually requested. */
const CONTROLLER_NODE_ID = "supreme-matter-controller";

/** Controller-side diagnostics (§ requirement 15) — never includes credentials. */
export interface MatterControllerDiagnostics {
  connected: boolean;
  matterRuntimeVersion: string;
  commissionedNodeCount: number;
  reachableNodeCount: number;
  endpointCount: number;
  nodes: {
    nodeId: string;
    interviewState: MatterNodeModel["interviewState"];
    reachable: boolean;
    lastSeenAt: string | null;
    lastInterviewError: string | null;
    endpointCount: number;
  }[];
}

export class RealMatterController implements MatterController {
  private node: ServerNode | undefined;
  private readonly opts: RealMatterControllerOptions;
  private readonly store: MatterDeviceModelStore;

  constructor(opts: RealMatterControllerOptions = {}) {
    this.opts = opts;
    this.store =
      opts.deviceModelStore ??
      (opts.storagePath
        ? new FileMatterDeviceModelStore(`${opts.storagePath}/device-models.json`)
        : new InMemoryMatterDeviceModelStore());
  }

  async connect(): Promise<void> {
    if (this.node) return;
    // § Correctness — suppress the credential-bearing PASE/CASE NOTICE-level session log
    // (mirrors matter-bridge/real-server.ts's identical suppression); real WARN/ERROR
    // commissioning failures still surface.
    Logger.facilityLevels = { Commissioning: LogLevel.WARN };

    const nodeId = this.opts.nodeId ?? CONTROLLER_NODE_ID;

    // § an explicit `port` (tests only — see the option's doc comment) gets a bounded
    // bind-retry with a FRESH random port on failure: some Windows hosts return EACCES for a
    // specific random port with no way to know in advance (observed live — Hyper-V/WSL NAT
    // reserves ranges of the ephemeral space), a transient "this one port is unavailable"
    // condition, not a logic bug. Without an explicit port (production, the standard 5540),
    // a bind failure is a real, actionable conflict and still throws immediately, unchanged.
    const maxAttempts = this.opts.port ? 5 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Fresh Environment per controller instance (and per retry) — never `Environment.default`
      // (its services are created once and cached on that one instance; sharing it would leak
      // storage/endpoint state, as matter-bridge/real-server.ts's own history documents).
      const environment = new Environment(nodeId, Environment.default);
      if (this.opts.storagePath) environment.vars.set("storage.path", this.opts.storagePath);
      const port = attempt === 0 ? this.opts.port : randomEphemeralPort();
      try {
        this.node = await ServerNode.create({
          id: nodeId,
          environment,
          ...(port ? { network: { port } } : {}),
          basicInformation: {
            vendorName: "Supreme Domotics",
            productName: "SupremeOS Matter Controller",
            nodeLabel: "SupremeOS Matter Controller",
          },
        });
        await this.node.start();
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        this.node = undefined;
        if (!isBindError(err)) throw err;
      }
    }
    if (lastError) throw lastError;

    // § requirement 9 — re-discovery on reconnect: every peer already on the fabric gets
    // re-interviewed so a restart neither loses topology nor duplicates it (identity is
    // derived from nodeId/endpointId, so re-interviewing the same peer overwrites its
    // existing stored model rather than creating a new one).
    for (const client of this.node!.peers) {
      await this.reinterview(client);
    }
  }

  async disconnect(): Promise<void> {
    await this.node?.close();
    this.node = undefined;
  }

  /**
   * (§ Matter Controller Extension, Phase 3 — driver integration) Delegates to the generic
   * cluster engine (`./cluster-engine.ts`) rather than containing Matter-specific command
   * logic itself: `MatterProtocolDriver` → `RealMatterController` → generic engine →
   * `@matter/main`. `cluster`/`command` are the existing string names `../matter-codec.ts`
   * already produces (§ requirement 5 keeps `INativeProtocolDriver`'s contract stable) — the
   * engine resolves them against the endpoint's REAL runtime cluster/command metadata, never
   * a hard-coded per-device-type table.
   */
  async invoke(addr: MatterAddress, cluster: string, command: string, fields: Record<string, unknown> = {}): Promise<void> {
    if (!this.node) throw new Error("matter-controller: not connected");
    const client = this.getClientNode(addr.nodeId);
    const model = this.store.get(addr.nodeId);
    await engineInvokeCommand(client, model, addr.nodeId, addr.endpoint, cluster, command, fields);
  }

  /** Generic attribute read (§ requirement 1) — numeric or real-runtime-name identity. */
  async readAttribute(nodeId: string, endpointId: number, cluster: number | string, attribute: number | string): Promise<MatterReadResult> {
    return engineReadAttribute(this.getClientNode(nodeId), this.store.get(nodeId), nodeId, endpointId, cluster, attribute);
  }

  /** Generic attribute write (§ requirement 2) — numeric or real-runtime-name identity. */
  async writeAttribute(
    nodeId: string,
    endpointId: number,
    cluster: number | string,
    attribute: number | string,
    value: unknown,
  ): Promise<MatterWriteResult> {
    return engineWriteAttribute(this.getClientNode(nodeId), this.store.get(nodeId), nodeId, endpointId, cluster, attribute, value);
  }

  /** Generic command invocation (§ requirement 3) — numeric or real-runtime-name identity. */
  async invokeCommand(
    nodeId: string,
    endpointId: number,
    cluster: number | string,
    command: number | string,
    fields: Record<string, unknown> = {},
  ): Promise<MatterInvokeResult> {
    return engineInvokeCommand(this.getClientNode(nodeId), this.store.get(nodeId), nodeId, endpointId, cluster, command, fields);
  }

  /** The single place a live peer is looked up by id — never duplicated across
   * read/write/invoke (§ requirement 4). `undefined` when commissioned but not currently a
   * live fabric peer; `target-resolver.ts` turns that into a `node_not_found` error. */
  private getClientNode(nodeId: string): ClientNode | undefined {
    if (!this.node) return undefined;
    return [...this.node.peers].find((p) => p.id === nodeId);
  }

  subscribe(_addr: MatterAddress, _handler: (report: MatterAttributeReport) => void): () => void {
    this.opts.onLog?.(
      "warn",
      "matter-controller: attribute subscriptions not yet implemented — Phase 3 generic cluster engine",
    );
    return () => {};
  }

  async nodes(): Promise<MatterNodeInfo[]> {
    if (!this.node) throw new Error("matter-controller: not connected");
    return [...this.node.peers].map((client) => this.toNodeInfo(client));
  }

  async commission(payload: MatterOnboardingPayload): Promise<MatterNodeInfo> {
    if (!this.node) throw new Error("matter-controller: not connected");
    const client = await this.node.peers.commission({
      passcode: payload.passcode,
      discriminator: payload.discriminator,
      ...(this.opts.commissionTimeoutSeconds ? { timeout: Seconds(this.opts.commissionTimeoutSeconds) } : {}),
    });
    // § requirement 8 — commissioning success and interview success are separate states.
    // A failed interview here does not undo the commission or throw out of this method;
    // it is recorded on the persisted model and surfaced via diagnostics/discover().
    await this.reinterview(client);
    return this.toNodeInfo(client);
  }

  /**
   * (§ Phase 3.1 — deterministic/manual commissioning) Commission a device at a KNOWN UDP
   * address, bypassing mDNS commissionable-device discovery/scanning entirely. This is a
   * real, `@matter/main`-supported manual-commissioning path — `Peers.forDescriptor()` +
   * `ClientNode.commission()`, exactly as `RemoteDescriptor`'s own doc comment describes
   * ("After calling forDescriptor, commission the returned node via ClientNode.commission")
   * — not an invented API. Only the DISCOVERY/scanning step is skipped; PASE/CASE
   * commissioning itself is identical to `commission()` above. Genuinely useful for a
   * known-IP device an installer enters manually, and is what this package's own tests use
   * on a host where multicast delivery between two same-process `@matter/main` nodes is
   * unreliable (§ Phase 3.1 environment investigation) — normal mDNS-based `commission()`
   * remains SupremeOS's only production commissioning path; nothing here changes it.
   */
  async commissionAtAddress(address: { ip: string; port: number }, payload: MatterOnboardingPayload): Promise<MatterNodeInfo> {
    if (!this.node) throw new Error("matter-controller: not connected");
    // § Phase 3.1 real diagnostic finding: `ClientNode.commission()` internally does
    // `node.owner.act(agent => agent.load(ControllerBehavior))` (verified directly against
    // `@matter/node`'s own `CommissioningClient.commission()` source) — but a plain
    // `ServerNode.create()` root endpoint does NOT declare `ControllerBehavior` as a
    // supported behavior at all ("Unsupported behavior" on `agent.load()`, confirmed live).
    // The normal mDNS `Peers.commission()` path evidently arranges this as part of its own
    // discovery/commissioner setup; this bypass path must add support explicitly first via
    // `Behaviors.require()` (a real, documented `@matter/node` API — "Add behavior support
    // dynamically at runtime" — not invented) before `load()` can activate it. (§ Phase 3.3 —
    // investigated whether this lazy, per-commission-call placement was itself the cause of a
    // real PASE `InvalidParam` rejection: disproven by a vanilla, zero-SupremeOS repro that
    // moved this same load earlier with a settling delay and still hit the identical failure.
    // The actual PASE rejection is unrelated to this call's placement — see
    // SESSION_HANDOFF.md's Phase 3.3 entry for the real root-cause status.)
    this.node.behaviors.require(ControllerBehavior);
    await this.node.act((agent) => agent.load(ControllerBehavior));
    const descriptor = {
      deviceIdentifier: `manual-${address.ip}-${address.port}`,
      D: payload.discriminator,
      CM: 1,
      addresses: [{ type: "udp" as const, ip: address.ip, port: address.port }],
    };
    const client = await this.node.peers.forDescriptor(descriptor);
    await client.commission({
      passcode: payload.passcode,
      discriminator: payload.discriminator,
      ...(this.opts.commissionTimeoutSeconds ? { timeout: Seconds(this.opts.commissionTimeoutSeconds) } : {}),
    });
    await this.reinterview(client);
    return this.toNodeInfo(client);
  }

  /** Retrieve the full persisted device-interview model for one node (§ requirement 7 —
   * kept separate from `MatterController`'s transport-neutral interface; callers that want
   * the real endpoint hierarchy use this directly rather than the flattened `MatterNodeInfo`). */
  getDeviceModel(nodeId: string): MatterNodeModel | undefined {
    return this.store.get(nodeId);
  }

  /** Re-run the device interview for an already-commissioned peer, reconciling against the
   * previously stored topology (§ requirement 9) and never marking a temporarily unreachable
   * node as permanently failed — only this one interview attempt's outcome changes. */
  private async reinterview(client: ClientNode): Promise<void> {
    const previous = this.store.get(client.id);
    try {
      const model = interviewNode(client, this.opts.onLog);
      if (previous) {
        logTopologyChanges(client.id, previous, model, this.opts.onLog);
      }
      this.store.put(model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.onLog?.("warn", `matter-controller: interview failed for node ${client.id} — ${message}`);
      this.store.put({
        ...(previous ?? emptyModel(client.id)),
        reachable: false,
        interviewState: "failed",
        lastInterviewError: message,
      });
    }
  }

  private toNodeInfo(client: ClientNode): MatterNodeInfo {
    const model = this.store.get(client.id);
    const nonRootEndpoints = model?.endpoints.filter((e) => e.endpointId !== 0) ?? [];
    const clusterNames = new Set<string>();
    for (const ep of nonRootEndpoints) {
      for (const c of ep.serverClusters) if (c.name) clusterNames.add(c.name);
    }
    return {
      nodeId: client.id,
      endpoint: nonRootEndpoints[0]?.endpointId ?? 1,
      clusters: [...clusterNames],
      vendor: model?.vendorName ?? (model?.vendorId !== undefined && model?.vendorId !== null ? String(model.vendorId) : undefined),
      product: model?.productName ?? (model?.productId !== undefined && model?.productId !== null ? String(model.productId) : undefined),
      endpoints: model?.endpoints,
      interviewState: model?.interviewState,
      lastInterviewError: model?.lastInterviewError,
    };
  }

  /** § requirement 15 — controller diagnostics, no secrets. */
  diagnostics(): MatterControllerDiagnostics {
    const models = this.store.all();
    return {
      connected: this.node !== undefined,
      matterRuntimeVersion: MATTER_RUNTIME_VERSION,
      commissionedNodeCount: models.length,
      reachableNodeCount: models.filter((m) => m.reachable).length,
      endpointCount: models.reduce((n, m) => n + m.endpoints.length, 0),
      nodes: models.map((m) => ({
        nodeId: m.nodeId,
        interviewState: m.interviewState,
        reachable: m.reachable,
        lastSeenAt: m.lastSeenAt,
        lastInterviewError: m.lastInterviewError,
        endpointCount: m.endpoints.length,
      })),
    };
  }
}

/** `@matter/main`'s own version — the Matter RUNTIME version, distinct from this extension's
 * own `supreme-matter` driver-manifest version (§ requirement 17/18). */
const MATTER_RUNTIME_VERSION = "0.17.9";

function randomEphemeralPort(): number {
  return 49152 + Math.floor(Math.random() * 15000);
}

function isBindError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /EACCES|EADDRINUSE|address.*in use|Cannot bind/i.test(message);
}

function emptyModel(nodeId: string): MatterNodeModel {
  return {
    nodeId,
    vendorId: null,
    productId: null,
    softwareVersion: null,
    hardwareVersion: null,
    vendorName: null,
    productName: null,
    reachable: true,
    lastSeenAt: null,
    interviewState: "pending",
    lastInterviewError: null,
    endpoints: [],
  };
}

function logTopologyChanges(
  nodeId: string,
  previous: MatterNodeModel,
  current: MatterNodeModel,
  onLog?: (level: "info" | "warn" | "error", message: string) => void,
): void {
  const prevIds = new Set(previous.endpoints.map((e) => e.endpointId));
  const currIds = new Set(current.endpoints.map((e) => e.endpointId));
  for (const id of currIds) if (!prevIds.has(id)) onLog?.("info", `matter-controller: node ${nodeId} gained endpoint ${id}`);
  for (const id of prevIds) if (!currIds.has(id)) onLog?.("info", `matter-controller: node ${nodeId} lost endpoint ${id}`);
}

/** Factory matching `MatterDriverOptions.createController` — plugs straight into
 * `MatterProtocolDriver`'s existing extension seam without changing its shape. */
export async function createRealMatterController(opts: {
  storagePath?: string;
}): Promise<MatterController> {
  const controller = new RealMatterController(opts);
  await controller.connect();
  return controller;
}
