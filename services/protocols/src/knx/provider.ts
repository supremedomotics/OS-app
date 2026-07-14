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
