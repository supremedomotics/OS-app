import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import {
  bindingKey,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import { defaultDpt, stateFromValue, valueFromCommand } from "../knx-codec.js";
import { KnxTaskRouter } from "./task-router.js";
import { KnxUltimateProvider } from "./knx-ultimate-provider.js";
import { KnxIotProvider } from "./knx-iot-provider.js";
import { parseFunctionalBlocks } from "./functional-block-parser.js";
import { mapUnifiedDevices, type KnxIotDiscoverySignal, type UnifiedKnxDevice, type UnifiedDeviceMapperInput } from "./unified-device-mapper.js";
import { OfflineCommandQueue, type DrainResult } from "./offline-command-queue.js";
import type { IKnxProvider, ProviderDiagnostics } from "./provider.js";

/**
 * Supreme KNX Driver (§ Public Architecture) — the ONLY thing the rest of SupremeOS
 * ever sees for KNX. Implements the exact same {@link INativeProtocolDriver} contract
 * every other protocol driver does, so it plugs into the existing Driver Lifecycle,
 * Device Ownership, and command-routing architecture with ZERO changes anywhere else
 * in the platform (§ Existing SupremeOS Components — do not recreate).
 *
 * Internally, every unit of work is delegated through the {@link KnxTaskRouter} to a
 * specialized provider (today: {@link KnxUltimateProvider} only — see the architecture
 * document for why no KNX IoT provider exists in this codebase yet). Device ownership
 * belongs to THIS class, never to a provider (§ Ownership) — `bindings`/`devices`
 * below are the single source of truth; providers only execute tasks handed to them.
 */
export interface SupremeKnxDriverOptions {
  host: string;
  port?: number;
  /** Injectable for tests; defaults to the real {@link KnxUltimateProvider}. */
  ultimateProvider?: IKnxProvider;
  /** Injectable for tests; defaults to the real {@link KnxIotProvider}. Registered only
   * for discovery.* kinds it can honestly serve (§ Compatibility Report) — never for
   * bus/dpt/security/transport, which stay KNX Ultimate's (§ no duplication). */
  iotProvider?: IKnxProvider;
}

interface KnxDeviceBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  writeGa: string;
  statusGa: string;
  dpt: string;
  config: Record<string, unknown>;
}

export class SupremeKnxDriver implements INativeProtocolDriver {
  readonly protocol = "knx";
  private readonly router = new KnxTaskRouter();
  private readonly ultimate: IKnxProvider;
  private readonly iot: IKnxProvider;
  private readonly bindings: KnxDeviceBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private connected = false;

  // Unified Device Intelligence counters (§ Diagnostics — Phase 3). Real, only set when
  // discoverUnified() has actually run; null/unset until then, never fabricated.
  private lastFunctionalBlockUpdate: string | null = null;
  private lastMetadataSync: string | null = null;
  private lastUnifiedDeviceCount: number | null = null;
  private lastUnifiedCapabilityCount: number | null = null;

  // State Synchronization counters (§ Phase 7). Real, only set once syncAll() has
  // actually run — null until then, never fabricated.
  private lastSyncAt: string | null = null;
  private lastSyncCount: number | null = null;
  private lastSyncErrorCount: number | null = null;

  // Offline Command Queue (§ Enterprise Reliability — Queue Recovery Policy): a command
  // issued while disconnected queues (MERGE + TTL-EXPIRE) instead of failing outright.
  private readonly offlineQueue = new OfflineCommandQueue<DeviceId, CapabilityCommand>({
    keyOf: (deviceId, command) => `${deviceId}:${command.capability}`,
  });
  private lastQueueDrainAt: string | null = null;
  private lastQueueDrainResult: DrainResult | null = null;

  constructor(opts: SupremeKnxDriverOptions) {
    this.ultimate = opts.ultimateProvider ?? new KnxUltimateProvider({ host: opts.host, port: opts.port });
    const iot = opts.iotProvider ?? new KnxIotProvider();
    this.iot = iot;
    // State Synchronization (§ Phase 7) + Queue Recovery (§ Enterprise Reliability):
    // whenever the transport provider (re)establishes a connection — first connect OR a
    // Connection-Manager-supervised reconnect after an outage — read back every bound
    // device's current value AND flush whatever commands queued while offline, rather
    // than waiting indefinitely for a spontaneous telegram or silently dropping what the
    // homeowner asked for. Feature-detected: only providers that expose real connection-
    // state transitions (today: KnxUltimateProvider) trigger this; a provider/fake
    // without it just never fires it, never fabricated.
    const supervisedUltimate = this.ultimate as Partial<{
      onConnectionStateChange: (cb: (state: string, previous: string) => void) => () => void;
    }>;
    supervisedUltimate.onConnectionStateChange?.((state) => {
      if (state === "connected") {
        void this.syncAll();
        void this.drainOfflineQueue();
      }
    });
    // Routing table (§ Internal Task Router): every bus/DPT/security/transport task
    // kind goes to KNX Ultimate — unchanged, KNX IoT never duplicates group
    // communication. discovery.metadata/functional_blocks now route to the real KNX
    // IoT provider (§ Compatibility Report); the remaining discovery.* kinds stay
    // unregistered — no live KNX IoT device in this environment to validate them
    // against yet.
    for (const kind of [
      "bus.group_write", "bus.group_read", "bus.monitor",
      "dpt.encode", "dpt.decode",
      "security.knx_secure", "transport.routing", "transport.tunneling",
    ] as const) {
      this.router.register(kind, this.ultimate);
    }
    for (const kind of ["discovery.metadata", "discovery.functional_blocks"] as const) {
      this.router.register(kind, iot);
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.ultimate.initialize();
    await this.ultimate.connect();
    this.connected = true;
    for (const b of this.bindings) this.observe(b);
  }

  async disconnect(): Promise<void> {
    await this.ultimate.disconnect();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const cfg = binding.config ?? {};
    const entry: KnxDeviceBinding = {
      deviceId: binding.deviceId,
      capability: binding.capability,
      writeGa: binding.address,
      statusGa: typeof cfg.statusAddress === "string" ? cfg.statusAddress : binding.address,
      dpt: typeof cfg.dpt === "string" ? cfg.dpt : defaultDpt(binding.capability as CapabilityState["kind"]),
      config: cfg,
    };
    this.bindings.push(entry);
    this.devices.add(binding.deviceId); // ownership lives here, never in a provider (§ Ownership)
    if (this.connected) this.observe(entry);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`supreme-knx: ${deviceId} not bound for ${command.capability}`);
    if (!this.connected) {
      // Queue Recovery (§ Enterprise Reliability): accepted, not lost — flushed (MERGE +
      // TTL-EXPIRE) the moment the connection returns, per {@link OfflineCommandQueue}'s
      // documented policy. Still optimistically reflects the command so the UI shows the
      // homeowner's intent immediately, exactly like the connected path below.
      this.offlineQueue.enqueue(deviceId, command);
      const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
      const value = valueFromCommand(command, prev, b.dpt);
      const optimistic = value !== null ? stateFromValue(b.capability as CapabilityState["kind"], value, b.config) : null;
      if (optimistic) this.record(b, optimistic);
      return;
    }
    await this.executeCommand(b, command);
  }

  private async executeCommand(b: KnxDeviceBinding, command: CapabilityCommand): Promise<void> {
    const prev = this.states.get(bindingKey(b.deviceId, command.capability)) ?? null;
    const value = valueFromCommand(command, prev, b.dpt);
    if (value === null) throw new Error(`supreme-knx: unsupported command for ${command.capability}`);
    await this.router.execute({ kind: "bus.group_write", groupAddress: b.writeGa, dpt: b.dpt, value });
    // Optimistically reflect the command; a status telegram will confirm/correct it —
    // identical contract to every other native driver in this codebase.
    const optimistic = stateFromValue(b.capability as CapabilityState["kind"], value, b.config);
    if (optimistic) this.record(b, optimistic);
  }

  /** Flushes whatever commands queued while disconnected (§ Queue Recovery), executing
   * each through the SAME path a live command takes — never a separate, duplicated write
   * mechanism. Safe to call with an empty queue (no-op) and safe on a driver with no
   * bindings for a queued device (that command silently can't execute — the binding was
   * presumably removed while offline; nothing to do about a device that no longer
   * exists). */
  async drainOfflineQueue(): Promise<DrainResult> {
    const result = await this.offlineQueue.drain(async (deviceId, command) => {
      const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
      if (!b) return;
      await this.executeCommand(b, command);
    });
    this.lastQueueDrainAt = new Date().toISOString();
    this.lastQueueDrainResult = result;
    return result;
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // Aggregated across every registered provider (§ Internal Task Router — discovery
    // is KNX IoT's job once that provider exists; KNX Ultimate reports none today).
    const all: DiscoveredDevice[] = [];
    for (const provider of this.router.registeredProviders()) all.push(...(await provider.discover()));
    return all;
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Unified Device Pipeline (§ Unified Device Intelligence — Phase 3): KNX Discovery →
   * KNX IoT Provider → Functional Blocks → Semantic Metadata → ETS Metadata → Universal
   * Circuit Grouping → Capability Detection → Unified Device Mapper → Supreme Device.
   *
   * Neither provider owns the result — this method only COLLECTS what each provider
   * contributes (KNX IoT's discovery + functional blocks; the caller's own ETS signals)
   * and hands them to {@link mapUnifiedDevices}. Ownership of whatever devices get
   * bound from this result stays with THIS driver via {@link bind}, same as always
   * (§ Architectural Rule — unchanged from Phase 1/2). */
  async discoverUnified(
    ets?: UnifiedDeviceMapperInput["ets"],
    userOverrides?: UnifiedDeviceMapperInput["userOverrides"],
  ): Promise<UnifiedKnxDevice[]> {
    const iotDiscovered = await this.iot.discover();
    const knxIotSignals: KnxIotDiscoverySignal[] = [];
    for (const d of iotDiscovered) {
      const host = String(d.raw.host);
      const linkFormat = String(d.raw.linkFormat);
      let functionalBlocks: KnxIotDiscoverySignal["functionalBlocks"];
      try {
        const body = (await this.router.execute({ kind: "discovery.functional_blocks", host })) as string;
        functionalBlocks = parseFunctionalBlocks(body).blocks;
        this.lastFunctionalBlockUpdate = new Date().toISOString();
      } catch {
        // No functional-block response for this device yet — the device still exists
        // with whatever grouping/name-based classification is possible (§ pipeline:
        // every stage enriches, none is required for a device to appear at all).
        functionalBlocks = undefined;
      }
      knxIotSignals.push({ host, linkFormat, functionalBlocks });
    }

    const result = mapUnifiedDevices({ knxIot: knxIotSignals, ets, userOverrides });
    this.lastMetadataSync = new Date().toISOString();
    this.lastUnifiedDeviceCount = result.length;
    this.lastUnifiedCapabilityCount = result.reduce((n, d) => n + d.capabilities.length, 0);
    return result;
  }

  /** State Synchronization (§ Phase 7): issues a real `bus.group_read` for every bound
   * device's status address — never waits indefinitely for a spontaneous telegram. Each
   * binding is read independently (one failure never blocks the rest); the actual
   * values arrive asynchronously through the normal subscribe()/record() path exactly
   * like any other status update, so no separate result-handling exists here — this
   * method's job is only to REQUEST them. Safe to call with zero bindings (a no-op) and
   * safe to call repeatedly (idempotent — a read that's already in flight just gets a
   * duplicate GroupValueResponse, handled the same as any duplicate telegram). */
  async syncAll(): Promise<{ requested: number; failed: number }> {
    let failed = 0;
    for (const b of this.bindings) {
      try {
        await this.router.execute({ kind: "bus.group_read", groupAddress: b.statusGa, dpt: b.dpt });
      } catch {
        failed++; // a provider without a real group-read implementation, or a transient
        // failure — never lets one binding's failure stop the rest from syncing.
      }
    }
    this.lastSyncAt = new Date().toISOString();
    this.lastSyncCount = this.bindings.length;
    this.lastSyncErrorCount = failed;
    return { requested: this.bindings.length, failed };
  }

  /** Diagnostics (§ Diagnostics) — this driver's own ownership/registration facts, every
   * provider's real, non-fabricated counters, and the Unified Device Pipeline's own
   * results once {@link discoverUnified} has run at least once (null fields until then —
   * never a fabricated zero pretending the pipeline has already run). */
  diagnostics(): {
    protocol: string;
    connected: boolean;
    deviceCount: number;
    bindingCount: number;
    providers: ProviderDiagnostics[];
    transportProvider: string;
    metadataProvider: string;
    lastFunctionalBlockUpdate: string | null;
    lastMetadataSync: string | null;
    unifiedDeviceCount: number | null;
    unifiedCapabilityCount: number | null;
    lastSyncAt: string | null;
    lastSyncCount: number | null;
    lastSyncErrorCount: number | null;
    queuedCommandCount: number;
    lastQueueDrainAt: string | null;
    lastQueueDrainResult: DrainResult | null;
  } {
    return {
      protocol: this.protocol,
      connected: this.connected,
      deviceCount: this.devices.size,
      bindingCount: this.bindings.length,
      providers: this.router.diagnostics(),
      transportProvider: this.ultimate.name,
      metadataProvider: this.iot.name,
      lastFunctionalBlockUpdate: this.lastFunctionalBlockUpdate,
      lastMetadataSync: this.lastMetadataSync,
      unifiedDeviceCount: this.lastUnifiedDeviceCount,
      unifiedCapabilityCount: this.lastUnifiedCapabilityCount,
      lastSyncAt: this.lastSyncAt,
      lastSyncCount: this.lastSyncCount,
      lastSyncErrorCount: this.lastSyncErrorCount,
      queuedCommandCount: this.offlineQueue.size(),
      lastQueueDrainAt: this.lastQueueDrainAt,
      lastQueueDrainResult: this.lastQueueDrainResult,
    };
  }

  private observe(b: KnxDeviceBinding): void {
    this.ultimate.subscribe(b.statusGa, b.dpt, (value) => {
      const state = stateFromValue(b.capability as CapabilityState["kind"], value as never, b.config);
      if (state) this.record(b, state);
    });
  }

  private record(b: KnxDeviceBinding, state: CapabilityState): void {
    const k = bindingKey(b.deviceId, b.capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) l({ deviceId: b.deviceId, capability: b.capability, state, ts: new Date().toISOString() });
  }
}
