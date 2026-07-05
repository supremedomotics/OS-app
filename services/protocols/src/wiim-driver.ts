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
import { ssdpSearch, type SsdpResponse, type SsdpSearchOptions } from "./ssdp.js";
import { commandToLinkPlay, stateFromLinkPlay } from "./wiim-codec.js";

export interface WiimDriverOptions {
  /** Poll period in ms for player status (default 3000). */
  pollMs?: number;
  /** Injectable fetch (tests point at an in-process LinkPlay server). */
  fetchImpl?: typeof fetch;
  /** Injectable SSDP searcher (tests); defaults to a real multicast M-SEARCH. */
  ssdp?: (opts?: SsdpSearchOptions) => Promise<SsdpResponse[]>;
}

interface WiimBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  host: string;
}

/**
 * Real WiiM / LinkPlay streamer driver (§3) over the openly-documented HTTP API. Each
 * streamer is its own IP host (bind `address` = host); commands are GET httpapi calls,
 * status is polled. Emits the Supreme `media` capability; confines all LinkPlay detail.
 */
export class WiimProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "wiim";
  private connected = false;
  private readonly opts: WiimDriverOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly bindings: WiimBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: WiimDriverOptions = {}) {
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
    if (!b) throw new Error(`wiim: ${deviceId} not bound for ${command.capability}`);
    const cmd = commandToLinkPlay(command);
    if (!cmd) throw new Error(`wiim: unsupported command for ${command.capability}`);
    const res = await this.fetchImpl(`${this.base(b.host)}/httpapi.asp?command=${encodeURIComponent(cmd)}`);
    if (!res.ok) throw new Error(`wiim: ${res.status}`);
    await res.text();
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // Real SSDP discovery: WiiM/LinkPlay announce as UPnP MediaRenderers; identify them
    // by "LinkPlay" / "WiiM" in the SERVER header. backendId is the device IP (= bind addr).
    const search = this.opts.ssdp ?? ssdpSearch;
    const responses = await search({ st: "urn:schemas-upnp-org:device:MediaRenderer:1" });
    return responses
      .filter((r) => /linkplay|wiim/i.test(`${r.server ?? ""} ${r.usn ?? ""}`))
      .map((r) => ({
        backendId: r.address,
        suggestedName: /wiim/i.test(r.server ?? "") ? `WiiM ${r.address}` : `LinkPlay ${r.address}`,
        capabilities: ["media"] as DiscoveredDevice["capabilities"],
        raw: { server: r.server ?? null, location: r.location ?? null },
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
        const res = await this.fetchImpl(`${this.base(b.host)}/httpapi.asp?command=getPlayerStatus`);
        if (!res.ok) continue;
        const json = (await res.json()) as Record<string, unknown>;
        this.record(b.deviceId, "media", stateFromLinkPlay(json));
      } catch {
        // A transient poll error must not stop the others.
      }
    }
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
