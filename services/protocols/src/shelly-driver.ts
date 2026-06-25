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
import {
  capabilitiesFromShellyStatus,
  commandToShellyRpc,
  stateFromShellyStatus,
} from "./shelly-codec.js";
import { mdnsBrowse, type MdnsService } from "./mdns.js";

const SHELLY_SERVICE = "_shelly._tcp.local";

export interface ShellyDriverOptions {
  pollMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable mDNS browser (tests); defaults to a real Bonjour browse. */
  mdns?: (serviceType: string) => Promise<MdnsService[]>;
}

interface ShellyBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  host: string;
  id: number;
}

/**
 * Real Shelly Gen2+ driver (§3) over the documented JSON-RPC HTTP API. Each device is its
 * own IP host (bind `address` = host; `config.id` = component index, default 0). Commands
 * are `POST /rpc` calls; status is polled via `Shelly.GetStatus`. mDNS discovery enriches
 * each device with its real capabilities. Emits onoff / brightness / position / sensor.
 */
export class ShellyProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "shelly";
  private connected = false;
  private readonly fetchImpl: typeof fetch;
  private readonly opts: ShellyDriverOptions;
  private readonly bindings: ShellyBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private rpcId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ShellyDriverOptions = {}) {
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
    const id = typeof binding.config?.id === "number" ? binding.config.id : 0;
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, host: binding.address, id });
    this.devices.add(binding.deviceId);
  }
  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`shelly: ${deviceId} not bound for ${command.capability}`);
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const call = commandToShellyRpc(command, b.id, prev);
    if (!call) throw new Error(`shelly: unsupported command for ${command.capability}`);
    await this.rpc(b.host, call.method, call.params);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // mDNS-find Shelly devices, then query each for its real components → capabilities.
    const browse = this.opts.mdns ?? mdnsBrowse;
    const services = await browse(SHELLY_SERVICE);
    const out: DiscoveredDevice[] = [];
    for (const s of services) {
      const host = s.addresses[0] ?? s.host;
      if (!host) continue;
      let capabilities: CapabilityKind[] = ["onoff"];
      try {
        const status = await this.rpc(host, "Shelly.GetStatus", {});
        const inferred = capabilitiesFromShellyStatus(status);
        if (inferred.length > 0) capabilities = inferred;
      } catch {
        // fall back to onoff if the device can't be queried right now
      }
      out.push({
        backendId: host,
        suggestedName: s.txt.id ? `Shelly ${s.txt.id}` : `Shelly ${host}`,
        capabilities,
        raw: { host: s.host, txt: s.txt },
      });
    }
    return out;
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async poll(): Promise<void> {
    // One GetStatus per distinct host serves all that host's bindings.
    const hosts = new Set(this.bindings.map((b) => b.host));
    for (const host of hosts) {
      try {
        const status = await this.rpc(host, "Shelly.GetStatus", {});
        for (const b of this.bindings) {
          if (b.host !== host) continue;
          const state = stateFromShellyStatus(b.capability, status, b.id);
          if (state) this.record(b.deviceId, b.capability, state);
        }
      } catch {
        // tolerate transient errors
      }
    }
  }

  private async rpc(host: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.base(host)}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: this.rpcId++, method, params }),
    });
    if (!res.ok) throw new Error(`shelly: ${res.status}`);
    const json = (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
    if (json.error) throw new Error(`shelly rpc error: ${JSON.stringify(json.error)}`);
    return json.result ?? {};
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
