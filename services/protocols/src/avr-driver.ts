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
import { buildMediaState, commandToAvr, parseAvrLine, parseHostPort } from "./avr-codec.js";

export interface AvrDriverOptions {
  /** Default control port (Denon/Marantz Telnet = 23). */
  port?: number;
  /** Injectable socket factory (tests point at an in-process AVR server). */
  createSocket?: (host: string, port: number) => net.Socket;
}

interface AvrBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  host: string;
  port: number;
}

interface AvrLink {
  socket: net.Socket | null;
  buffer: string;
}

interface MediaCache {
  volume: number;
  muted: boolean;
  source: string | null;
}

/**
 * Real AVR IP-control driver (§3) — Denon/Marantz receivers over their published ASCII
 * Telnet protocol. Each receiver is its own IP host, so this driver manages a TCP link
 * per bound host, sends control tokens, and parses the receiver's unsolicited status
 * echoes into Supreme onoff + media state. Confines all AVR detail; emits pure Supreme
 * capabilities.
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
    for (const link of this.links.values()) link.socket?.destroy();
    this.links.clear();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const { host, port } = parseHostPort(binding.address, this.defaultPort);
    const key = `${host}:${port}`;
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, host, port });
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
    const tokens = commandToAvr(command, prev);
    if (!tokens) throw new Error(`avr: unsupported command for ${command.capability}`);
    const link = this.ensureLink(`${b.host}:${b.port}`, b.host, b.port);
    for (const t of tokens) link.socket?.write(`${t}\r`);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return []; // AVRs are added by IP; no broadcast discovery here
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private ensureLink(key: string, host: string, port: number): AvrLink {
    let link = this.links.get(key);
    if (link?.socket && !link.socket.destroyed) return link;
    link = { socket: null, buffer: "" };
    this.links.set(key, link);
    const socket = this.opts.createSocket
      ? this.opts.createSocket(host, port)
      : net.connect(port, host);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(key, host, port, chunk));
    socket.on("connect", () => {
      // Query current state so we start in sync.
      socket.write("PW?\rMV?\rMU?\rSI?\r");
    });
    socket.on("close", () => {
      const l = this.links.get(key);
      if (l) l.socket = null;
    });
    socket.on("error", () => {
      /* surfaced via close; lazy reconnect on next command */
    });
    link.socket = socket;
    return link;
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
    if (update.kind === "power") {
      this.emitFor(host, port, "onoff", { kind: "onoff", on: update.on });
      return;
    }
    // Volume / mute / source all fold into the media capability's composite state.
    const mediaBinding = this.bindings.find((b) => b.host === host && b.port === port && b.capability === "media");
    if (!mediaBinding) return;
    const cache = this.media.get(mediaBinding.deviceId) ?? { volume: 0, muted: false, source: null };
    if (update.kind === "volume") cache.volume = update.volume;
    else if (update.kind === "mute") cache.muted = update.muted;
    else if (update.kind === "source") cache.source = update.source;
    this.media.set(mediaBinding.deviceId, cache);
    this.record(mediaBinding.deviceId, "media", buildMediaState(cache));
  }

  private emitFor(host: string, port: number, capability: CapabilityKind, state: CapabilityState): void {
    const b = this.bindings.find((x) => x.host === host && x.port === port && x.capability === capability);
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
