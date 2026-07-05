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
import { DEVIALET_STATE_PATHS, commandToDevialet, stateFromDevialet } from "./devialet-codec.js";
import { mdnsBrowse, type MdnsService } from "./mdns.js";

/** The Bonjour service type Devialet speakers advertise. */
const DEVIALET_SERVICE = "_devialet-http._tcp.local";

export interface DevialetDriverOptions {
  pollMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable mDNS browser (tests); defaults to a real Bonjour browse. */
  mdns?: (serviceType: string) => Promise<MdnsService[]>;
}

interface DevialetBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  host: string;
}

/**
 * Real Devialet (Phantom) driver (§3) over the local `/ipcontrol/v1` HTTP API. Each
 * speaker/group is its own IP host (bind `address` = host); commands are HTTP calls,
 * volume + playback are polled. Emits the Supreme `media` capability.
 */
export class DevialetProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "devialet";
  private connected = false;
  private readonly fetchImpl: typeof fetch;
  private readonly opts: DevialetDriverOptions;
  private readonly bindings: DevialetBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DevialetDriverOptions = {}) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async connect(): Promise<void> {
    this.connected = true;
    const period = this.opts.pollMs ?? 3000;
    this.timer = setInterval(() => void this.poll(), period);
    (this.timer as { unref?: () => void }).unref?.();
  }
  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, host: binding.address });
    this.devices.add(binding.deviceId);
  }
  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`devialet: ${deviceId} not bound for ${command.capability}`);
    const call = commandToDevialet(command);
    if (!call) throw new Error(`devialet: unsupported command for ${command.capability}`);
    const res = await this.fetchImpl(`${this.base(b.host)}${call.path}`, {
      method: call.method,
      headers: call.body ? { "content-type": "application/json" } : undefined,
      body: call.body ? JSON.stringify(call.body) : undefined,
    });
    if (!res.ok) throw new Error(`devialet: ${res.status}`);
    await res.text();
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // Real mDNS/Bonjour discovery: Devialet speakers advertise _devialet-http._tcp.
    // backendId is the resolved IP (= the bind address for HTTP control).
    const browse = this.opts.mdns ?? mdnsBrowse;
    const services = await browse(DEVIALET_SERVICE);
    return services
      .filter((s) => s.addresses.length > 0)
      .map((s) => ({
        backendId: s.addresses[0]!,
        suggestedName: instanceName(s) ?? `Devialet ${s.addresses[0]}`,
        capabilities: ["media"] as DiscoveredDevice["capabilities"],
        raw: { host: s.host, port: s.port, txt: s.txt },
      }));
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async poll(): Promise<void> {
    for (const b of this.bindings) {
      if (b.capability !== "media") continue;
      try {
        const [vol, play] = await Promise.all([
          this.json(b.host, DEVIALET_STATE_PATHS.volume),
          this.json(b.host, DEVIALET_STATE_PATHS.playback),
        ]);
        this.record(b.deviceId, "media", stateFromDevialet(vol, play));
      } catch {
        // tolerate transient errors
      }
    }
  }

  private async json(host: string, path: string): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.base(host)}${path}`);
    if (!res.ok) throw new Error(`devialet: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private base(host: string): string {
    return host.startsWith("http") ? host.replace(/\/$/, "") : `http://${host}`;
  }

  private record(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState): void {
    const k = bindingKey(deviceId, capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) {
      l({ deviceId, capability, state, ts: new Date().toISOString() });
    }
  }
}

/** A friendly name from the Bonjour instance (the label before the service type). */
function instanceName(s: MdnsService): string | null {
  const label = s.name.split(`.${DEVIALET_SERVICE.replace(/^\./, "")}`)[0];
  return label && label !== s.name ? label.replace(/\\032/g, " ") : null;
}
