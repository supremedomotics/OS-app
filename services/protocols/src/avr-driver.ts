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
import { buildMediaState, commandToAvr, denonCapabilityConfig, parseAvrLine, parseHostPort, type AvrZone } from "./avr-codec.js";
import { ReconnectScheduler } from "./avr-reconnect.js";
import { ssdpSearch, type SsdpResponse, type SsdpSearchOptions } from "./ssdp.js";
import { bestEffortMacForIp } from "./arp-lookup.js";
import { DriverDiagnosticsTracker, type DriverDiagnosticsSnapshot } from "./driver-diagnostics.js";

/** Kept in sync with `supreme-avr`'s manifest `version` (services/drivers/src/manifests.ts)
 * — surfaced in Diagnostics so an installer can tell which driver build is running. */
const DRIVER_VERSION = "1.0.0";

export interface AvrDriverOptions {
  /** Default control port (Denon/Marantz Telnet = 23). */
  port?: number;
  /** Injectable socket factory (tests point at an in-process AVR server). */
  createSocket?: (host: string, port: number) => net.Socket;
  /** Reconnect backoff floor / ceiling (ms). Defaults 2_000 / 60_000. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Injectable SSDP searcher (tests); defaults to a real multicast M-SEARCH. */
  ssdp?: (opts?: SsdpSearchOptions) => Promise<SsdpResponse[]>;
  /** Surfaces connection lifecycle events (connect/error) to the Extension Center's driver
   * log / system log — without this a socket that never connects fails completely silently. */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

interface AvrBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  host: string;
  port: number;
  /** Which zone this binding controls — "main" (power/volume/mute/source/tone/DSP) or
   * "zone2" (power/mute/source only; no documented Zone 2 volume token, see avr-codec.ts). */
  zone: AvrZone;
  /** Installer-declared: does this unit have tone control (bass/treble)? Telnet has no
   * feature-query command (see avr-codec.ts), so this can't be wire-detected. */
  hasToneControl: boolean;
}

interface AvrLink {
  socket: net.Socket | null;
  /** True only once THIS socket's "connect" event has actually fired — a freshly-created
   * socket is non-null but not yet connected, so `socket !== null` alone isn't a safe
   * "can I write to this" check (see command()). */
  ready: boolean;
  buffer: string;
  reconnect: ReconnectScheduler;
  diagnostics: DriverDiagnosticsTracker;
}

interface MediaCache {
  volume: number;
  volumeDb?: number;
  muted: boolean;
  source: string | null;
  bass?: number;
  treble?: number;
  soundMode?: string;
  sleepMinutes?: number | null;
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
    const hasToneControl = binding.config?.hasToneControl !== false;
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, host, port, zone, hasToneControl });
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
    // A dropped/never-established/still-connecting socket must fail LOUDLY — silently
    // swallowing the write (the previous behavior) reports "success" for a command the
    // receiver never saw. `ready` (not just `socket !== null`) matters: ensureLink() may have
    // just started a brand-new connection attempt that hasn't finished yet.
    if (!link.ready || !link.socket || link.socket.destroyed) {
      throw new Error(`avr: not connected to ${b.host}:${b.port} — check the receiver's IP and that Network Control/Telnet is enabled`);
    }
    for (const t of tokens) {
      link.diagnostics.recordSend(t);
      link.socket.write(`${t}\r`);
    }
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  getCapabilityConfig(deviceId: DeviceId, capability: CapabilityKind): Record<string, unknown> | null {
    if (capability !== "media") return null;
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === "media");
    if (!b) return null;
    const hasZone2 = this.bindings.some((x) => x.host === b.host && x.port === b.port && x.zone === "zone2");
    return denonCapabilityConfig({ hasZone2, hasToneControl: b.zone === "main" && b.hasToneControl }) as unknown as Record<string, unknown>;
  }

  /** Diagnostics Console (§ Universal AV Driver SDK) — real per-link counters/timestamps,
   * never fabricated. `null` when this device's zone/host has no link yet (never bound or
   * never connected). MAC is a best-effort local ARP-table read (§ arp-lookup.ts); Denon's
   * classic Telnet protocol exposes no model/firmware/serial on the wire (verified against
   * the spec, see avr-codec.ts module doc), so those stay honestly `null`. */
  getDiagnostics(deviceId: DeviceId): DriverDiagnosticsSnapshot | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    const link = this.links.get(`${b.host}:${b.port}`);
    const status = !link ? "disconnected" : link.ready ? "connected" : link.socket ? "connecting" : "disconnected";
    const empty = new DriverDiagnosticsTracker();
    return (link?.diagnostics ?? empty).snapshot(status, {
      protocol: this.protocol,
      driverVersion: DRIVER_VERSION,
      model: null,
      firmware: null,
      ip: b.host,
      mac: bestEffortMacForIp(b.host),
    });
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // The classic Telnet control protocol itself defines no SSDP presence (verified:
    // none is documented in the spec) — but every Denon/Marantz unit that exposes
    // Telnet also ships HEOS (standard across the lineup since ~2014, same physical
    // receiver), which DOES answer SSDP on this Denon-defined search target. This is
    // therefore "co-located discovery": finding the HEOS presence to locate the same
    // box's Telnet port (23, this driver's default), not a wire-verified Telnet
    // capability. An installer should confirm Network Control / Telnet is enabled in
    // the unit's setup menu before binding — some models ship it off by default.
    const search = this.opts.ssdp ?? ssdpSearch;
    const responses = await search({ st: "urn:schemas-denon-com:device:ACT-Denon:1" });
    return responses.map((r) => ({
      backendId: r.address,
      suggestedName: `AVR ${r.address}`,
      capabilities: ["onoff", "media"] as DiscoveredDevice["capabilities"],
      raw: { ip: r.address, server: r.server ?? null, location: r.location ?? null, bindConfig: { zone: "main" } },
    }));
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
        if (l) {
          l.diagnostics.recordReconnect();
          this.openSocket(l, host, port);
        }
      },
    });
    link = { socket: null, ready: false, buffer: "", reconnect, diagnostics: new DriverDiagnosticsTracker() };
    this.links.set(key, link);
    this.openSocket(link, host, port);
    return link;
  }

  private openSocket(link: AvrLink, host: string, port: number): void {
    link.ready = false;
    const socket = this.opts.createSocket ? this.opts.createSocket(host, port) : net.connect(port, host);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(`${host}:${port}`, host, port, chunk));
    socket.on("connect", () => {
      link.ready = true;
      link.reconnect.reset();
      this.opts.onLog?.("info", `Connected to ${host}:${port}`);
      // Query current state so we start in sync (main zone + zone 2 if bound).
      const initTokens = ["PW?", "MV?", "MU?", "SI?", "PSTONE CTRL ?", "PSBAS ?", "PSTRE ?", "MS?"];
      if (this.bindings.some((b) => `${b.host}:${b.port}` === `${host}:${port}` && b.zone === "zone2")) {
        initTokens.push("Z2?", "Z2MU?");
      }
      for (const t of initTokens) link.diagnostics.recordSend(t);
      socket.write(`${initTokens.join("\r")}\r`);
    });
    socket.on("close", () => {
      const l = this.links.get(`${host}:${port}`);
      if (l) {
        l.socket = null;
        l.ready = false;
        l.reconnect.notifyDisconnected();
      }
    });
    socket.on("error", (err) => {
      // The "close" handler still runs right after this (Node always fires close following
      // error) and drives reconnection — this just makes the failure visible instead of silent.
      link.diagnostics.recordError(err.message);
      this.opts.onLog?.("error", `${host}:${port}: ${err.message}`);
    });
    link.socket = socket;
  }

  private onData(key: string, host: string, port: number, chunk: string): void {
    const link = this.links.get(key);
    if (!link) return;
    link.buffer += chunk;
    const lines = link.buffer.split("\r");
    link.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) link.diagnostics.recordReceive(line);
      this.onLine(host, port, line);
    }
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
        this.patchMedia(host, port, "main", (c) => { c.volume = update.volume; c.volumeDb = update.volumeDb; });
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
        this.patchMedia(host, port, "main", (c) => { c.sleepMinutes = update.minutes; });
        return;
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
