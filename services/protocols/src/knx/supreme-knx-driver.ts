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
  private readonly bindings: KnxDeviceBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private connected = false;

  constructor(opts: SupremeKnxDriverOptions) {
    this.ultimate = opts.ultimateProvider ?? new KnxUltimateProvider({ host: opts.host, port: opts.port });
    // Routing table (§ Internal Task Router): every bus/DPT/security/transport task
    // kind goes to KNX Ultimate. discovery.* kinds are deliberately left unregistered —
    // see the architecture document; registering a future KNX IoT provider here is a
    // one-line addition, never a change to this driver or the router itself.
    for (const kind of [
      "bus.group_write", "bus.group_read", "bus.monitor",
      "dpt.encode", "dpt.decode",
      "security.knx_secure", "transport.routing", "transport.tunneling",
    ] as const) {
      this.router.register(kind, this.ultimate);
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
    if (!this.connected) throw new Error("supreme-knx: not connected");
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`supreme-knx: ${deviceId} not bound for ${command.capability}`);
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const value = valueFromCommand(command, prev, b.dpt);
    if (value === null) throw new Error(`supreme-knx: unsupported command for ${command.capability}`);
    await this.router.execute({ kind: "bus.group_write", groupAddress: b.writeGa, dpt: b.dpt, value });
    // Optimistically reflect the command; a status telegram will confirm/correct it —
    // identical contract to every other native driver in this codebase.
    const optimistic = stateFromValue(b.capability as CapabilityState["kind"], value, b.config);
    if (optimistic) this.record(b, optimistic);
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

  /** Diagnostics (§ Diagnostics) — this driver's own ownership/registration facts,
   * plus every provider's real, non-fabricated counters. */
  diagnostics(): { protocol: string; connected: boolean; deviceCount: number; bindingCount: number; providers: ProviderDiagnostics[] } {
    return {
      protocol: this.protocol,
      connected: this.connected,
      deviceCount: this.devices.size,
      bindingCount: this.bindings.length,
      providers: this.router.diagnostics(),
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
