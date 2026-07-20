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
import { ssdpSearch, type SsdpResponse, type SsdpSearchOptions } from "./ssdp.js";
import { bestEffortMacForIp } from "./arp-lookup.js";
import type { DriverDiagnosticsSnapshot } from "./driver-diagnostics.js";
import { removeDeviceBindings, removeDeviceStates } from "./binding-cleanup.js";
import { recordCapabilityState } from "./av-sdk/state-cache.js";
import { TcpLineTransport, type TcpLink } from "./av-sdk/tcp-line-transport.js";

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
  private readonly transport: TcpLineTransport;
  private readonly states = new Map<string, CapabilityState>();
  private readonly media = new Map<DeviceId, MediaCache>();
  private readonly listeners = new Set<StateListener>();

  constructor(opts: AvrDriverOptions = {}) {
    this.opts = opts;
    this.defaultPort = opts.port ?? 23;
    this.transport = new TcpLineTransport({
      delimiter: "\r",
      reconnectBaseMs: opts.reconnectBaseMs,
      reconnectMaxMs: opts.reconnectMaxMs,
      createSocket: opts.createSocket,
      onLog: opts.onLog,
      onConnect: (link, socket, host, port) => this.onLinkConnect(link, socket, host, port),
      onLine: (ctx, line) => this.onLine(ctx.host, ctx.port, line),
    });
  }

  async connect(): Promise<void> {
    // Receivers connect lazily per bound host; nothing global to open.
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.transport.disconnectAll();
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
    if (this.connected) this.transport.ensureLink(key, host, port);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  /** § Driver Lifecycle Completion — releases this one device's bindings/cached
   * state/media cache, and additionally tears down its TCP link (reconnect scheduler +
   * socket) once no other bound device (e.g. main zone / zone2 sharing the same
   * host:port) still uses it. Idempotent. */
  async unbind(deviceId: DeviceId): Promise<void> {
    const removed = this.bindings.filter((b) => b.deviceId === deviceId);
    removeDeviceBindings(this.bindings, deviceId);
    this.devices.delete(deviceId);
    removeDeviceStates(this.states, deviceId);
    this.media.delete(deviceId);
    const releasedKeys = new Set(removed.map((b) => `${b.host}:${b.port}`));
    for (const key of releasedKeys) {
      if (this.bindings.some((b) => `${b.host}:${b.port}` === key)) continue;
      this.transport.releaseKey(key);
    }
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    // § Production Hardening — Driver Lifecycle audit: without this, a command issued
    // after disconnect() silently re-opened a brand-new TCP socket via ensureLink()
    // instead of failing — the driver is supposed to be torn down at that point, not
    // quietly resurrect a connection behind the caller's back.
    if (!this.connected) throw new Error(`avr: driver is disconnected — cannot command ${deviceId}`);
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`avr: ${deviceId} not bound for ${command.capability}`);
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const tokens = commandToAvr(command, prev, b.zone);
    if (!tokens) throw new Error(`avr: unsupported command for ${command.capability} (zone ${b.zone})`);
    const link = this.transport.ensureLink(`${b.host}:${b.port}`, b.host, b.port);
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
    const { status, diagnostics } = this.transport.diagnosticsFor(`${b.host}:${b.port}`);
    return diagnostics.snapshot(status, {
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

  /** `TcpLineTransport`'s `onConnect` hook — the one genuinely Denon/Marantz-specific piece
   * of what used to be `openSocket()`'s connect handler (link readiness/reconnect-reset/the
   * "Connected to…" log line are now owned by the transport itself). Queries current state
   * so the driver starts in sync (main zone + zone 2 if bound). */
  private onLinkConnect(link: TcpLink, socket: net.Socket, host: string, port: number): void {
    const initTokens = ["PW?", "MV?", "MU?", "SI?", "PSTONE CTRL ?", "PSBAS ?", "PSTRE ?", "MS?"];
    if (this.bindings.some((b) => `${b.host}:${b.port}` === `${host}:${port}` && b.zone === "zone2")) {
      initTokens.push("Z2?", "Z2MU?");
    }
    for (const t of initTokens) link.diagnostics.recordSend(t);
    socket.write(`${initTokens.join("\r")}\r`);
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
    recordCapabilityState(this.states, this.listeners, deviceId, capability, state);
  }
}
