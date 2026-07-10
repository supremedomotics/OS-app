import net from "node:net";
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
import { buildMediaState, commandToAvr, parseAvrLine, parseHostPort, type AvrZone } from "./avr-codec.js";
import { ReconnectScheduler } from "./avr-reconnect.js";

export interface AvrDriverOptions {
  /** Default control port (Denon/Marantz Telnet = 23). */
  port?: number;
  /** Injectable socket factory (tests point at an in-process AVR server). */
  createSocket?: (host: string, port: number) => net.Socket;
  /** Reconnect backoff floor / ceiling (ms). Defaults 2_000 / 60_000. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

interface AvrBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  host: string;
  port: number;
  /** Which zone this binding controls — "main" (power/volume/mute/source/tone/DSP) or
   * "zone2" (power/mute/source only; no documented Zone 2 volume token, see avr-codec.ts). */
  zone: AvrZone;
}

interface AvrLink {
  socket: net.Socket | null;
  buffer: string;
  reconnect: ReconnectScheduler;
}

interface MediaCache {
  volume: number;
  muted: boolean;
  source: string | null;
  bass?: number;
  treble?: number;
  soundMode?: string;
}

/**
 * Real AVR IP-control driver (§3) — Denon/Marantz receivers over their published ASCII
 * Telnet protocol. Each receiver is its own IP host, so this driver manages a TCP link
 * per bound host (auto-reconnected with capped backoff on drop), sends control tokens,
 * and parses the receiver's unsolicited status echoes into Supreme state. Confines all
 * AVR detail; emits pure Supreme capabilities.
 *
 * Zone 2 is modeled as its own Supreme device (its own deviceId, own room) bound to the
 * SAME host:port link as the main zone — the same "one connection, many Supreme devices"
 * pattern every multi-binding driver in this fleet already uses. Which zone a binding
 * targets comes from `ProtocolBinding.config.zone` ("main" | "zone2", default "main"),
 * set at commissioning — Telnet has no wire-level way to discover Zone 2 presence (the
 * spec documents it as a per-model footnote, not a queryable fact), so this is
 * installer-declared, exactly as `denonCapabilityConfig` in avr-codec.ts documents.
 */
export class AvrProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "avr";
  private connected = false;
  private readonly opts: AvrDriverOptions;
  private readonly defaultPort: number;
  private readonly bindings: AvrBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly links = new Map<string, AvrLink>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly media = new Map<DeviceId, MediaCache>();
  private readonly listeners = new Set<StateListener>();

  constructor(opts: AvrDriverOptions = {}) {
    this.opts = opts;
    this.defaultPort = opts.port ?? 23;
  }

  async connect(): Promise<void> {
    // Receivers connect lazily per bound host; nothing global to open.
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    for (const link of this.links.values()) {
      link.reconnect.stop();
      link.socket?.destroy();
    }
    this.links.clear();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const { host, port } = parseHostPort(binding.address, this.defaultPort);
    const key = `${host}:${port}`;
    const zone: AvrZone = binding.config?.zone === "zone2" ? "zone2" : "main";
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, host, port, zone });
    this.devices.add(binding.deviceId);
    if (binding.capability === "media" && !this.media.has(binding.deviceId)) {
      this.media.set(binding.deviceId, { volume: 0, muted: false, source: null });
    }
    if (this.connected) this.ensureLink(key, host, port);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`avr: ${deviceId} not bound for ${command.capability}`);
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const tokens = commandToAvr(command, prev, b.zone);
    if (!tokens) throw new Error(`avr: unsupported command for ${command.capability} (zone ${b.zone})`);
    const link = this.ensureLink(`${b.host}:${b.port}`, b.host, b.port);
    for (const t of tokens) link.socket?.write(`${t}\r`);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return []; // AVRs are added by IP; no broadcast discovery on the classic Telnet protocol
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private ensureLink(key: string, host: string, port: number): AvrLink {
    let link = this.links.get(key);
    if (link?.socket && !link.socket.destroyed) return link;
    if (link) {
      // Re-establishing a previously-dropped link — reuse its reconnect scheduler state.
      this.openSocket(link, host, port);
      return link;
    }
    const reconnect = new ReconnectScheduler({
      baseMs: this.opts.reconnectBaseMs,
      maxMs: this.opts.reconnectMaxMs,
      reconnect: async () => {
        const l = this.links.get(key);
        if (l) this.openSocket(l, host, port);
      },
    });
    link = { socket: null, buffer: "", reconnect };
    this.links.set(key, link);
    this.openSocket(link, host, port);
    return link;
  }

  private openSocket(link: AvrLink, host: string, port: number): void {
    const socket = this.opts.createSocket ? this.opts.createSocket(host, port) : net.connect(port, host);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(`${host}:${port}`, host, port, chunk));
    socket.on("connect", () => {
      link.reconnect.reset();
      // Query current state so we start in sync (main zone + zone 2 if bound).
      socket.write("PW?\rMV?\rMU?\rSI?\rPSTONE CTRL ?\rPSBAS ?\rPSTRE ?\rMS?\r");
      if (this.bindings.some((b) => `${b.host}:${b.port}` === `${host}:${port}` && b.zone === "zone2")) {
        socket.write("Z2?\rZ2MU?\r");
      }
    });
    socket.on("close", () => {
      const l = this.links.get(`${host}:${port}`);
      if (l) {
        l.socket = null;
        l.reconnect.notifyDisconnected();
      }
    });
    socket.on("error", () => {
      // Surfaced via "close"; the reconnect scheduler picks it up from there.
    });
    link.socket = socket;
  }

  private onData(key: string, host: string, port: number, chunk: string): void {
    const link = this.links.get(key);
    if (!link) return;
    link.buffer += chunk;
    const lines = link.buffer.split("\r");
    link.buffer = lines.pop() ?? "";
    for (const line of lines) this.onLine(host, port, line);
  }

  private onLine(host: string, port: number, line: string): void {
    const update = parseAvrLine(line);
    if (!update) return;
    switch (update.kind) {
      case "power":
        this.emitFor(host, port, "onoff", "main", { kind: "onoff", on: update.on });
        return;
      case "zone2Power":
        this.emitFor(host, port, "onoff", "zone2", { kind: "onoff", on: update.on });
        return;
      case "volume":
        this.patchMedia(host, port, "main", (c) => { c.volume = update.volume; });
        return;
      case "mute":
        this.patchMedia(host, port, "main", (c) => { c.muted = update.muted; });
        return;
      case "source":
        this.patchMedia(host, port, "main", (c) => { c.source = update.source; });
        return;
      case "bass":
        this.patchMedia(host, port, "main", (c) => { c.bass = update.bass; });
        return;
      case "treble":
        this.patchMedia(host, port, "main", (c) => { c.treble = update.treble; });
        return;
      case "soundMode":
        this.patchMedia(host, port, "main", (c) => { c.soundMode = update.mode; });
        return;
      case "zone2Mute":
        this.patchMedia(host, port, "zone2", (c) => { c.muted = update.muted; });
        return;
      case "zone2Source":
        this.patchMedia(host, port, "zone2", (c) => { c.source = update.source; });
        return;
      case "sleep":
        return; // main-zone sleep timer isn't surfaced as Supreme state today
    }
  }

  private patchMedia(host: string, port: number, zone: AvrZone, patch: (cache: MediaCache) => void): void {
    const mediaBinding = this.bindings.find((b) => b.host === host && b.port === port && b.capability === "media" && b.zone === zone);
    if (!mediaBinding) return;
    const cache = this.media.get(mediaBinding.deviceId) ?? { volume: 0, muted: false, source: null };
    patch(cache);
    this.media.set(mediaBinding.deviceId, cache);
    this.record(mediaBinding.deviceId, "media", buildMediaState(cache));
  }

  private emitFor(host: string, port: number, capability: CapabilityKind, zone: AvrZone, state: CapabilityState): void {
    const b = this.bindings.find((x) => x.host === host && x.port === port && x.capability === capability && x.zone === zone);
    if (b) this.record(b.deviceId, capability, state);
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
