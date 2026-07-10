import dgram from "node:dgram";
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
import type { AvrRange } from "./avr-capabilities.js";
import {
  buildYamahaMediaState,
  commandToYamaha,
  isYamahaZone,
  parseUpnpDescription,
  parseYamahaEvent,
  parseYamahaFeatures,
  parseYamahaPlayInfo,
  parseYamahaZoneStatus,
  supremeRepeatFromYamaha,
  supremeShuffleFromYamaha,
  yamahaUrl,
  YAMAHA_ZONES,
  type YamahaFeatures,
  type YamahaMediaCache,
  type YamahaZone,
} from "./yamaha-codec.js";
import { ssdpSearch, type SsdpResponse, type SsdpSearchOptions } from "./ssdp.js";

/** Minimal UDP listening-socket surface (so tests inject a fake instead of a real
 * `dgram` bind) — mirrors the `SsdpSocket` shape in ssdp.ts. */
export interface YamahaEventSocket {
  on(event: "message", cb: (msg: Buffer, rinfo: { address: string }) => void): void;
  bind(cb: () => void): void;
  address(): { port: number };
  close(): void;
}
export type YamahaEventSocketFactory = () => YamahaEventSocket;

function defaultYamahaEventSocket(): YamahaEventSocket {
  const sock = dgram.createSocket({ type: "udp4" });
  return {
    on: (event, cb) => sock.on(event, cb),
    bind: (cb) => sock.bind(cb),
    address: () => sock.address() as { port: number },
    close: () => sock.close(),
  };
}

export interface YamahaDriverOptions {
  fetchImpl?: typeof fetch;
  /** Injectable UDP event listener (tests); defaults to a real bound `dgram` socket. */
  createEventSocket?: YamahaEventSocketFactory;
  /** How often to refresh the device's event-push registration (spec §11.2: it times
   * out after 10 minutes of silence). Default 8 minutes — safely under that. */
  eventRefreshMs?: number;
  /** Sent as the `X-AppName` header identifying this controller (spec §11.2). */
  appName?: string;
  /** Injectable SSDP searcher (tests); defaults to a real multicast M-SEARCH. */
  ssdp?: (opts?: SsdpSearchOptions) => Promise<SsdpResponse[]>;
}

interface YamahaBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  host: string;
  zone: YamahaZone;
}

interface YamahaHostInfo {
  features: YamahaFeatures;
  refreshTimer: ReturnType<typeof setInterval>;
}

/**
 * Real Yamaha Extended Control (YXC/MusicCast) driver (§3) — one physical unit per IP
 * host, up to 4 zones (main/zone2/zone3/zone4) each bindable as its own Supreme device
 * sharing that host's HTTP control + one shared UDP event listener. Every input's
 * dynamic capability (its `play_info_type`) and every zone's volume range/tone range/
 * input list/sound-program list come from a genuine wire query (`/system/getFeatures`)
 * — never hardcoded, unlike the Denon Telnet driver's installer-declared fallback,
 * because Yamaha's API actually offers this data.
 */
export class YamahaProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "yamaha";
  private connected = false;
  private readonly opts: YamahaDriverOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly bindings: YamahaBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly hosts = new Map<string, YamahaHostInfo>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly media = new Map<DeviceId, YamahaMediaCache>();
  private readonly listeners = new Set<StateListener>();
  private eventSocket: YamahaEventSocket | null = null;
  private eventPort: number | null = null;

  constructor(opts: YamahaDriverOptions = {}) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async connect(): Promise<void> {
    this.connected = true;
    const factory = this.opts.createEventSocket ?? defaultYamahaEventSocket;
    const socket = factory();
    this.eventPort = await new Promise<number>((resolve) => {
      socket.bind(() => resolve(socket.address().port));
    });
    socket.on("message", (msg, rinfo) => this.onEventMessage(rinfo.address, msg.toString()));
    this.eventSocket = socket;
  }

  async disconnect(): Promise<void> {
    for (const info of this.hosts.values()) clearInterval(info.refreshTimer);
    this.hosts.clear();
    this.eventSocket?.close();
    this.eventSocket = null;
    this.eventPort = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const host = binding.address;
    const zoneRaw = typeof binding.config?.zone === "string" ? binding.config.zone : "main";
    const zone: YamahaZone = isYamahaZone(zoneRaw) ? zoneRaw : "main";
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, host, zone });
    this.devices.add(binding.deviceId);
    if (!this.media.has(binding.deviceId)) {
      this.media.set(binding.deviceId, { power: false, volume: 0, muted: false, input: "", netusb: null });
    }
    if (this.connected) {
      await this.ensureHostFeatures(host);
      await this.syncZone(host, zone);
    }
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`yamaha: ${deviceId} not bound for ${command.capability}`);
    const hostInfo = await this.ensureHostFeatures(b.host);
    const volumeRange = hostInfo.features.zones.find((z) => z.id === b.zone)?.volumeRange ?? { min: 0, max: 100, step: 1 };
    const cache = this.media.get(deviceId);

    if (command.capability === "media" && command.action === "shuffle" && typeof command.shuffle === "boolean") {
      const current = cache?.netusb ? supremeShuffleFromYamaha(cache.netusb.shuffle) : false;
      if (current === command.shuffle) return; // toggle is the only wire primitive; already there
    }
    if (command.capability === "media" && command.action === "repeat" && command.repeat) {
      const current = cache?.netusb ? supremeRepeatFromYamaha(cache.netusb.repeat) : "off";
      if (current === command.repeat) return;
    }

    const requests = commandToYamaha(command, b.zone, { volumeRange });
    if (!requests) {
      throw new Error(`yamaha: unsupported command for ${command.capability}/${"action" in command ? command.action : "?"}`);
    }
    for (const req of requests) await this.getJson(b.host, req.group, req.method, req.params);
    await this.syncZone(b.host, b.zone); // reflect promptly; the UDP event confirms shortly after
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // Real SSDP discovery: MediaRenderer devices, filtered to Yamaha by fetching each
    // one's UPnP description XML and checking <manufacturer> (spec doesn't define a
    // Yamaha-specific ST, so this is the standard UPnP-level check).
    const search = this.opts.ssdp ?? ssdpSearch;
    const responses = await search({ st: "urn:schemas-upnp-org:device:MediaRenderer:1" });
    const out: DiscoveredDevice[] = [];
    for (const r of responses) {
      if (!r.location) continue;
      try {
        const res = await this.fetchImpl(r.location);
        if (!res.ok) continue;
        const xml = await res.text();
        const { manufacturer, friendlyName } = parseUpnpDescription(xml);
        if (!manufacturer || !/yamaha/i.test(manufacturer)) continue;
        out.push({
          backendId: r.address,
          suggestedName: friendlyName || `Yamaha ${r.address}`,
          capabilities: ["onoff", "media"] as DiscoveredDevice["capabilities"],
          // Defaults to the main zone — a unit's zone2/3/4 (if any) aren't discoverable
          // as separate SSDP hits, so they stay a manual second/third/fourth bind.
          raw: { ip: r.address, location: r.location, manufacturer, friendlyName: friendlyName ?? null, bindConfig: { zone: "main" } },
        });
      } catch {
        // tolerate one bad device during discovery
      }
    }
    return out;
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async ensureHostFeatures(host: string): Promise<YamahaHostInfo> {
    const existing = this.hosts.get(host);
    if (existing) return existing;
    const featuresJson = await this.getJson(host, "system", "getFeatures", {});
    const features = parseYamahaFeatures(featuresJson);
    const refreshMs = this.opts.eventRefreshMs ?? 8 * 60 * 1000;
    const refreshTimer = setInterval(() => {
      void this.getJson(host, "system", "getFeatures", {}).catch(() => {
        // transient network error — the next scheduled refresh tries again
      });
    }, refreshMs);
    (refreshTimer as { unref?: () => void }).unref?.();
    const info: YamahaHostInfo = { features, refreshTimer };
    this.hosts.set(host, info);
    return info;
  }

  private async syncZone(host: string, zone: YamahaZone): Promise<void> {
    const statusJson = await this.getJson(host, zone, "getStatus", {});
    const status = parseYamahaZoneStatus(statusJson);
    const inputType = this.hosts.get(host)?.features.systemInputs.find((i) => i.id === status.input)?.playInfoType ?? "none";
    let netusb: YamahaMediaCache["netusb"] = null;
    if (inputType === "netusb") {
      try {
        const playJson = await this.getJson(host, "netusb", "getPlayInfo", {});
        netusb = parseYamahaPlayInfo(playJson, host);
      } catch {
        // tolerate transient errors; last-known netusb state (if any) is left in place below
      }
    }
    for (const b of this.bindings.filter((x) => x.host === host && x.zone === zone)) {
      const cache = this.media.get(b.deviceId);
      if (!cache) continue;
      cache.power = status.power;
      cache.volume = status.volume;
      cache.muted = status.muted;
      cache.input = status.input;
      cache.soundProgram = status.soundProgram;
      cache.bass = status.bass;
      cache.treble = status.treble;
      cache.netusb = netusb;
      this.media.set(b.deviceId, cache);
    }
    this.emitZone(host, zone);
  }

  private onEventMessage(sourceIp: string, raw: string): void {
    const event = parseYamahaEvent(raw);
    if (!event) return;
    const host = this.bindings.find((b) => b.host === sourceIp)?.host;
    if (!host) return; // event from an IP we don't manage — ignore
    for (const zone of YAMAHA_ZONES) {
      const ze = event.zones[zone];
      if (!ze) continue;
      if (!this.bindings.some((b) => b.host === host && b.zone === zone)) continue;
      if (ze.statusUpdated || event.netusbPlayInfoUpdated) {
        void this.syncZone(host, zone);
        continue;
      }
      for (const b of this.bindings.filter((x) => x.host === host && x.zone === zone)) {
        const cache = this.media.get(b.deviceId);
        if (!cache) continue;
        if (ze.power !== undefined) cache.power = ze.power;
        if (ze.volume !== undefined) cache.volume = ze.volume;
        if (ze.muted !== undefined) cache.muted = ze.muted;
        if (ze.input !== undefined) cache.input = ze.input;
        this.media.set(b.deviceId, cache);
      }
      this.emitZone(host, zone);
    }
  }

  private emitZone(host: string, zone: YamahaZone): void {
    const volumeRange: AvrRange = this.hosts.get(host)?.features.zones.find((z) => z.id === zone)?.volumeRange ?? {
      min: 0, max: 100, step: 1,
    };
    for (const b of this.bindings.filter((x) => x.host === host && x.zone === zone)) {
      const cache = this.media.get(b.deviceId);
      if (!cache) continue;
      if (b.capability === "onoff") this.record(b.deviceId, "onoff", { kind: "onoff", on: cache.power });
      else if (b.capability === "media") this.record(b.deviceId, "media", buildYamahaMediaState(cache, volumeRange));
    }
  }

  private async getJson(host: string, group: string, method: string, params: Record<string, string | number>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {};
    if (this.eventPort !== null) {
      headers["X-AppName"] = this.opts.appName ?? "SupremeOS/1.0";
      headers["X-AppPort"] = String(this.eventPort);
    }
    const res = await this.fetchImpl(yamahaUrl(host, group, method, params), { method: "GET", headers });
    if (!res.ok) throw new Error(`yamaha: ${res.status} ${group}/${method}`);
    return (await res.json()) as Record<string, unknown>;
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
