import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import type { DiscoveredDevice } from "@supreme/integration-layer";

/**
 * Supreme KNX Driver — internal Provider Interface (§ Driver Provider Interface).
 *
 * The contract every internal KNX provider implements — today only
 * {@link "./knx-ultimate-provider.js" KnxUltimateProvider}, wrapping the real
 * `knxultimate` KNXnet/IP client. A future KNX IoT provider (no such dependency exists
 * in this codebase yet — see the architecture document's Migration Strategy section)
 * plugs into this exact same interface with zero changes to the Task Router or
 * {@link "./supreme-knx-driver.js" SupremeKnxDriver} above it.
 *
 * Providers never own devices and are never called directly by anything outside this
 * driver — only the Task Router dispatches to them (§ Ownership, § Internal Task Router).
 */

/** The specific units of work a provider can be asked to perform (§ Internal Task
 * Router). Each task type routes to exactly one provider — never a fallback chain. */
export type KnxTaskKind =
  | "discovery.metadata" | "discovery.semantic" | "discovery.functional_blocks"
  | "discovery.resource_model" | "discovery.room_metadata"
  | "bus.group_write" | "bus.group_read" | "bus.monitor"
  | "dpt.encode" | "dpt.decode"
  | "security.knx_secure" | "transport.routing" | "transport.tunneling";

export interface KnxGroupWriteTask {
  kind: "bus.group_write";
  groupAddress: string;
  dpt: string;
  value: unknown;
}
export interface KnxGroupReadTask {
  kind: "bus.group_read";
  groupAddress: string;
  dpt: string;
}
/** Real KNX IoT task (§ KnxIotProvider) — CoAP GET /fb on a device already surfaced by
 * discover(). host/port come from that discovery result, never guessed. */
export interface KnxFunctionalBlocksTask {
  kind: "discovery.functional_blocks";
  host: string;
  port?: number;
}
export type KnxTask = KnxGroupWriteTask | KnxGroupReadTask | KnxFunctionalBlocksTask;

export interface ProviderHealth {
  connected: boolean;
  lastError: string | null;
}

/** Diagnostics fields a provider can genuinely report. A field is `null`, never
 * fabricated, when this provider has no real signal for it (§ Diagnostics: never hide
 * failures, never swallow exceptions — the same discipline applies to never inventing
 * a number that isn't backed by a real counter). */
export interface ProviderDiagnostics {
  provider: string;
  connected: boolean;
  packetsSent: number;
  packetsReceived: number;
  lastTelegramAt: string | null;
  lastCommandAt: string | null;
  lastError: string | null;
  reconnectAttempts: number;
  /** Connection Manager state (§ Phase 6), when this provider is supervised by one —
   * null for providers with no supervised connection lifecycle (e.g. KNX IoT, which is
   * connectionless CoAP). Optional/nullable so no existing provider's diagnostics()
   * literal needs to change. */
  connectionState?: import("./connection-manager.js").ConnectionState | null;
  /** § PASS 19 diagnostic (KNX feedback pipeline investigation) — a real telegram
   * arrived on the bus (destination GA + payload both decoded successfully) but no
   * `subscribe()`'d handler was registered for that exact destination address string,
   * so it was silently dropped before ever reaching the driver/binding layer. A
   * nonzero, growing count here — while `packetsReceived` also grows — is the direct,
   * unambiguous signature of a GA-string-format mismatch between what the binding
   * engine stored (from ETS parsing) and what this provider's underlying KNX client
   * library reports at runtime (e.g. differing zero-padding, casing, or 2-level vs
   * 3-level group address notation) — NOT a bus/transport/actuator problem, which ETS's
   * own Group Monitor has already ruled out. Optional/nullable so no other provider's
   * `diagnostics()` literal needs to change (only `KnxUltimateProvider` populates it). */
  unmatchedFeedbackTelegrams?: number;
  /** § PASS 20 diagnostic (Part A) — the most recent feedback telegram that DID match a
   * subscribed observer, and the most recent one that DIDN'T, as two separate bounded
   * (one-entry) snapshots — never an unbounded log, never exposed for any capability
   * this provider isn't actively diagnosing. `null` until the first relevant telegram
   * of each kind ever arrives. Optional/nullable so no other provider's diagnostics()
   * literal needs to change. */
  lastFeedbackTelegram?: KnxFeedbackTelegramSnapshot | null;
  lastUnmatchedFeedback?: KnxFeedbackTelegramSnapshot | null;
}

/** § PASS 20 diagnostic (Part A) — one bounded snapshot of a feedback telegram, matched
 * or not. `value`/`dpt` are populated only for the matched case, where the DPT is
 * actually known (from the observer that matched) — decoding an unmatched telegram's
 * raw bytes with an assumed/guessed DPT would be unsafe and potentially misleading, so
 * the unmatched snapshot deliberately omits them. */
export interface KnxFeedbackTelegramSnapshot {
  source: string | null;
  destination: string;
  matched: boolean;
  dpt?: string;
  value?: unknown;
  ts: string;
}

export interface IKnxProvider {
  readonly name: string;

  initialize(): Promise<void>;
  discover(): Promise<DiscoveredDevice[]>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  execute(task: KnxTask): Promise<unknown>;
  subscribe(groupAddress: string, dpt: string, handler: (value: unknown) => void): void;
  unsubscribe(groupAddress: string): void;
  health(): ProviderHealth;
  diagnostics(): ProviderDiagnostics;
  shutdown(): Promise<void>;
}

// Re-exported so callers of the driver never need to reach into @supreme/integration-layer
// directly for this one type.
export type { DiscoveredDevice, CapabilityCommand, CapabilityKind, CapabilityState, DeviceId };
