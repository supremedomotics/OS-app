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
  type MediaQueueItem,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import {
  buildHeosCommand,
  buildHeosMediaState,
  commandToHeos,
  heosCapabilityConfig,
  parseHeosMessage,
  playbackFromHeosState,
  type HeosMediaCache,
  type HeosPlayerInfo,
} from "./heos-codec.js";
import { ssdpSearch, type SsdpResponse, type SsdpSearchOptions } from "./ssdp.js";
import { bestEffortMacForIp } from "./arp-lookup.js";
import type { DriverDiagnosticsSnapshot, DriverTraceEntry } from "./driver-diagnostics.js";
import { removeDeviceBindings, removeDeviceStates } from "./binding-cleanup.js";
import { recordCapabilityState } from "./av-sdk/state-cache.js";
import { TcpLineTransport, type TcpLink } from "./av-sdk/tcp-line-transport.js";
import { resolveHeosSourceLabel } from "./av-sdk/network-source-resolver.js";
import { createProtocolTracer, type ProtocolTracer } from "./av-sdk/protocol-tracer.js";
import { parseHostPort } from "./avr-codec.js";

/** Kept in sync with `supreme-heos`'s manifest `version` (services/drivers/src/manifests.ts). */
const DRIVER_VERSION = "1.0.0";

export interface HeosDriverOptions {
  /** HEOS CLI Telnet port (default 1255, per spec). */
  port?: number;
  /** Injectable socket factory (tests point at an in-process HEOS server). */
  createSocket?: (host: string, port: number) => net.Socket;
  /** Reconnect backoff floor / ceiling (ms). Defaults 2_000 / 60_000. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Injectable SSDP searcher (tests); defaults to a real multicast M-SEARCH. */
  ssdp?: (opts?: SsdpSearchOptions) => Promise<SsdpResponse[]>;
  /** How long discovery waits for a candidate host's `get_players` reply before
   * giving up on it (ms). Default 3000. */
  discoverTimeoutMs?: number;
  /** Surfaces connection lifecycle events (connect/error) to the Extension Center's driver
   * log / system log — without this a socket that never connects fails completely silently. */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /** § Production Bugfix Sprint — when true (and `onLog` is set), every raw token sent,
   * every line received, and every discover()/getCapabilityConfig() call is logged in
   * full sequence via `onLog`, prefixed `[trace:heos]`. Off by default — this is a
   * debugging aid, not a normal-operation log level. */
  trace?: boolean;
}

interface HeosBinding {
  deviceId: DeviceId;
  host: string;
  port: number;
  /** HEOS player id — the ONE connection to `host:port` addresses every player in the
   * house by `pid`; this is the same "one connection, many Supreme devices" shape the
   * AVR Telnet driver's zones use, but here the multiplexing is inherent to the wire
   * protocol rather than an installer config choice. */
  pid: string;
  /** `player/get_player_info`'s `model` field, threaded through from discovery's
   * `bindConfig.model` when present (§ Diagnostics Console) — HEOS is the only one of
   * the three AVR protocols in this fleet that reports a model over the wire at all. */
  model: string | null;
}

/**
 * Real HEOS CLI driver (§3) — Denon/Marantz's whole-home streaming/multi-room layer,
 * distinct from (and complementary to) the classic Denon/Marantz Telnet AVR driver: HEOS
 * has no power state (verified: no power command exists in the spec) and no tone/DSP
 * surface — its job is transport, volume, streaming inputs, and now-playing metadata.
 * One TCP connection per HEOS network (identified by any one player's IP) drives every
 * player on that network by `pid`; each Supreme device is bound to a `pid` via
 * `ProtocolBinding.config.pid`.
 */
export class HeosProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "heos";
  private connected = false;
  private readonly opts: HeosDriverOptions;
  private readonly defaultPort: number;
  private readonly bindings: HeosBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly transport: TcpLineTransport;
  private readonly states = new Map<string, CapabilityState>();
  private readonly media = new Map<DeviceId, HeosMediaCache>();
  private readonly listeners = new Set<StateListener>();
  private readonly pendingQueue = new Map<
    string,
    { resolve: (items: MediaQueueItem[] | null) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private queueSequence = 0;
  private readonly tracer: ProtocolTracer;

  constructor(opts: HeosDriverOptions = {}) {
    this.opts = opts;
    this.defaultPort = opts.port ?? 1255;
    this.tracer = createProtocolTracer("heos", opts.trace === true, opts.onLog);
    this.transport = new TcpLineTransport({
      delimiter: "\r\n",
      reconnectBaseMs: opts.reconnectBaseMs,
      reconnectMaxMs: opts.reconnectMaxMs,
      createSocket: opts.createSocket,
      onLog: opts.onLog,
      onConnect: (link, socket, host, port) => this.onLinkConnect(link, socket, host, port),
      onLine: (ctx, line) => this.onLine(ctx.link, line),
    });
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.transport.disconnectAll();
    for (const [sequence, pending] of this.pendingQueue) {
      clearTimeout(pending.timer);
      pending.resolve(null);
      this.pendingQueue.delete(sequence);
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    if (binding.capability !== "media") {
      // HEOS has no power/onoff surface (verified: no power command in the spec) — only
      // the media capability is meaningful here.
      throw new Error(`heos: unsupported capability ${binding.capability} (HEOS is a streaming-only protocol)`);
    }
    const pid = typeof binding.config?.pid === "string" ? binding.config.pid : null;
    if (!pid) throw new Error(`heos: binding for ${binding.deviceId} is missing required config.pid`);
    const { host, port } = parseHostPort(binding.address, this.defaultPort);
    const key = `${host}:${port}`;
    const model = typeof binding.config?.model === "string" ? binding.config.model : null;
    this.bindings.push({ deviceId: binding.deviceId, host, port, pid, model });
    this.devices.add(binding.deviceId);
    if (!this.media.has(binding.deviceId)) {
      this.media.set(binding.deviceId, {
        playback: "idle", volume: 0, muted: false, source: null, title: null, artist: null, album: null,
        artworkUrl: null, durationSec: null, positionSec: null, shuffle: null, repeat: null,
      });
    }
    if (this.connected) {
      const link = this.transport.ensureLink(key, host, port);
      if (link.socket && !link.socket.destroyed && !link.socket.connecting) this.syncPid(link, pid);
    }
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  /** § Driver Lifecycle Completion — releases this one device's binding/cached
   * state/media cache, and additionally tears down its shared HEOS network link
   * (reconnect scheduler + socket) once no other bound player on the same host:port
   * still uses it. Idempotent. */
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
    // § Production Hardening — Driver Lifecycle audit: same guard as AvrProtocolDriver
    // — a command after disconnect() must fail loudly, not silently re-open a socket.
    if (!this.connected) throw new Error(`heos: driver is disconnected — cannot command ${deviceId}`);
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) throw new Error(`heos: ${deviceId} not bound`);
    const cache = this.media.get(deviceId);
    const req = commandToHeos(command, b.pid, { repeat: cache?.repeat ?? "off", shuffle: cache?.shuffle ?? false });
    if (!req) throw new Error(`heos: unsupported command for ${command.capability}/${"action" in command ? command.action : "?"}`);
    const link = this.transport.ensureLink(`${b.host}:${b.port}`, b.host, b.port);
    // A dropped/never-established/still-connecting socket must fail LOUDLY — silently
    // swallowing the write (the previous behavior) reports "success" for a command the
    // player never saw. `ready` (not just `socket !== null`) matters: ensureLink() may have
    // just started a brand-new connection attempt that hasn't finished yet.
    if (!link.ready || !link.socket || link.socket.destroyed) {
      throw new Error(`heos: not connected to ${b.host}:${b.port} — check the player's IP is reachable`);
    }
    const line = buildHeosCommand(req.group, req.command, req.params);
    link.diagnostics.recordSend(line);
    this.tracer.event(`command ${deviceId} ${command.capability}/${"action" in command ? command.action : "?"} -> ${line}`);
    this.tracer.send(line);
    link.socket.write(`${line}\r\n`);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  getCapabilityConfig(deviceId: DeviceId, capability: CapabilityKind): Record<string, unknown> | null {
    if (capability !== "media" || !this.devices.has(deviceId)) return null;
    this.tracer.event(`getCapabilityConfig ${deviceId} — protocol_fixed (spec §4.4.13)`);
    return heosCapabilityConfig() as unknown as Record<string, unknown>;
  }

  /** § Capability Refresh (Part 2) — HEOS's `browse/play_input` input enum is a fixed
   * protocol-level fact (spec §4.4.13, see heos-codec.ts), not something an individual
   * unit reports differently, so there's no per-device capability query to re-run.
   * What this genuinely does: force the shared HEOS connection closed and immediately
   * re-open it, re-running `onLinkConnect`'s un-register/re-sync-every-bound-player/
   * re-register sequence — the same real resync (now-playing, volume, mute, play
   * mode) a natural reconnect performs, on demand. */
  async refreshCapabilities(deviceId: DeviceId): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b || !this.connected) return;
    const key = `${b.host}:${b.port}`;
    this.transport.releaseKey(key);
    this.transport.ensureLink(key, b.host, b.port);
  }

  /** Diagnostics Console (§ Universal AV Driver SDK) — real per-connection counters,
   * never fabricated. HEOS's `player/get_player_info` genuinely reports a model over
   * the wire (unlike Denon Telnet), threaded through from discovery; firmware is not
   * part of that response, so it stays honestly `null`. */
  getDiagnostics(deviceId: DeviceId): DriverDiagnosticsSnapshot | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    const { status, diagnostics } = this.transport.diagnosticsFor(`${b.host}:${b.port}`);
    return diagnostics.snapshot(status, {
      protocol: this.protocol,
      driverVersion: DRIVER_VERSION,
      model: b.model,
      firmware: null,
      ip: b.host,
      mac: bestEffortMacForIp(b.host),
    });
  }

  /** § Universal AVR SDK — same ring buffer `getDiagnostics()` already reads from,
   * populated automatically by every real `recordSend`/`recordReceive` call. */
  getTrace(deviceId: DeviceId): DriverTraceEntry[] | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    return this.transport.diagnosticsFor(`${b.host}:${b.port}`).diagnostics.recentTrace();
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // Real SSDP discovery: HEOS speakers answer this Denon-defined search target
    // (spec §2.1: ST = urn:schemas-denon-com:device:ACT-Denon:1). SSDP alone only
    // gives us candidate IPs; a HEOS *device* is really one or more *players* — so we
    // follow up with a real `player/get_players` query (spec §4.2.1) against each
    // candidate to resolve their actual pids and names, exactly what `bind()` needs
    // (`config.pid`). Any one HEOS unit's `get_players` response lists EVERY player on
    // that whole network, so results are deduped by pid across all queried hosts —
    // the same player answering via two different SSDP hits must not appear twice.
    const search = this.opts.ssdp ?? ssdpSearch;
    this.tracer.event("discover: SSDP M-SEARCH st=urn:schemas-denon-com:device:ACT-Denon:1");
    const responses = await search({ st: "urn:schemas-denon-com:device:ACT-Denon:1" });
    const hosts = [...new Set(responses.map((r) => r.address))];
    this.tracer.event(`discover: ${hosts.length} candidate host(s) — [${hosts.join(", ")}]`);
    const perHost = await Promise.all(hosts.map((host) => this.queryPlayers(host)));

    const out: DiscoveredDevice[] = [];
    const seenPid = new Set<string>();
    for (let i = 0; i < hosts.length; i++) {
      for (const player of perHost[i]!) {
        if (seenPid.has(player.pid)) continue;
        seenPid.add(player.pid);
        out.push({
          backendId: player.pid,
          suggestedName: player.name || `HEOS ${hosts[i]}`,
          capabilities: ["media"] as DiscoveredDevice["capabilities"],
          raw: {
            ip: hosts[i],
            model: player.model ?? null,
            bindConfig: { pid: player.pid, ...(player.model ? { model: player.model } : {}) },
            // §Automatic Room Assignment: a HEOS player's name is set by the homeowner/
            // installer during HEOS app room setup — a persistent, user-configurable
            // room/zone name (confidence tier "persistent_user_zone_name"), not a bare
            // device-model string the way an un-set SSDP friendlyName often is.
            ...(player.name ? { locationHint: { raw: player.name, source: "persistent_user_zone_name" } } : {}),
          },
        });
      }
    }
    return out;
  }

  /** One-off `player/get_players` query against a freshly-opened socket — used only
   * during discovery, separate from the persistent per-host `HeosLink`. Tolerates an
   * unresponsive/non-HEOS host by resolving an empty list rather than failing the
   * whole scan. */
  private queryPlayers(host: string): Promise<HeosPlayerInfo[]> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (players: HeosPlayerInfo[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(players);
      };
      const timer = setTimeout(() => finish([]), this.opts.discoverTimeoutMs ?? 3_000);
      (timer as { unref?: () => void }).unref?.();

      const socket = this.opts.createSocket ? this.opts.createSocket(host, this.defaultPort) : net.connect(this.defaultPort, host);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("connect", () => {
        const line = buildHeosCommand("player", "get_players", {});
        this.tracer.event(`discover: querying players on ${host}`);
        this.tracer.send(line);
        socket.write(`${line}\r\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\r\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          this.tracer.receive(line);
          const update = parseHeosMessage(line);
          if (update?.kind === "players") finish(update.players);
        }
      });
      socket.on("error", () => finish([]));
      socket.on("close", () => finish([]));
    });
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fetch the first 50 items of a player's HEOS queue (spec §4.2.13 `get_queue`).
   * HEOS has no per-request id, but its own spec (§2.1.3 "Miscellaneous") documents a
   * `sequence` argument that's echoed back verbatim in the response — the driver uses
   * that to correlate this one-off request against the shared multiplexed connection
   * without disturbing the unsolicited event stream. Resolves null on a dropped/slow
   * response rather than hanging the caller. */
  async getQueue(deviceId: DeviceId): Promise<MediaQueueItem[] | null> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    const link = this.transport.ensureLink(`${b.host}:${b.port}`, b.host, b.port);
    if (!link.socket || link.socket.destroyed) return null;
    const sequence = String(++this.queueSequence);
    const socket = link.socket;
    return new Promise<MediaQueueItem[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingQueue.delete(sequence);
        resolve(null);
      }, 5_000);
      (timer as { unref?: () => void }).unref?.();
      this.pendingQueue.set(sequence, { resolve: (items) => resolve(items), timer });
      const line = buildHeosCommand("player", "get_queue", { pid: b.pid, range: "0,49", sequence });
      link.diagnostics.recordSend(line);
      this.tracer.send(line);
      socket.write(`${line}\r\n`);
    });
  }

  /** `TcpLineTransport`'s `onConnect` hook — the genuinely HEOS-specific piece of what used
   * to be `openSocket()`'s connect handler (link readiness/reconnect-reset/the "Connected
   * to…" log line are now owned by the transport itself). Driver-init sequence per spec
   * §2.1.1: un-register events, sync every bound player's current state, then register for
   * change events. */
  private onLinkConnect(link: TcpLink, socket: net.Socket, host: string, port: number): void {
    this.tracer.event(`connected to ${host}:${port} — un-registering, syncing bound players, re-registering for change events`);
    const off = buildHeosCommand("system", "register_for_change_events", { enable: "off" });
    link.diagnostics.recordSend(off);
    this.tracer.send(off);
    socket.write(`${off}\r\n`);
    for (const pid of this.pidsFor(host, port)) this.syncPid(link, pid);
    const on = buildHeosCommand("system", "register_for_change_events", { enable: "on" });
    link.diagnostics.recordSend(on);
    this.tracer.send(on);
    socket.write(`${on}\r\n`);
  }

  private pidsFor(host: string, port: number): string[] {
    return [...new Set(this.bindings.filter((b) => b.host === host && b.port === port).map((b) => b.pid))];
  }

  private syncPid(link: TcpLink, pid: string): void {
    if (!link.socket) return;
    const queries = [
      buildHeosCommand("player", "get_play_state", { pid }),
      buildHeosCommand("player", "get_volume", { pid }),
      buildHeosCommand("player", "get_mute", { pid }),
      buildHeosCommand("player", "get_play_mode", { pid }),
      buildHeosCommand("player", "get_now_playing_media", { pid }),
    ];
    for (const q of queries) {
      link.diagnostics.recordSend(q);
      this.tracer.send(q);
      link.socket.write(`${q}\r\n`);
    }
  }

  private onLine(link: TcpLink, line: string): void {
    this.tracer.receive(line);
    const update = parseHeosMessage(line);
    if (!update) {
      this.tracer.event(`unrecognized line: ${JSON.stringify(line)}`);
      return;
    }
    switch (update.kind) {
      case "playState":
        this.patchMedia(update.pid, (c) => { c.playback = playbackFromHeosState(update.state); });
        return;
      case "volume":
        this.patchMedia(update.pid, (c) => {
          c.volume = update.level;
          if (update.muted !== undefined) c.muted = update.muted;
        });
        return;
      case "mute":
        this.patchMedia(update.pid, (c) => { c.muted = update.muted; });
        return;
      case "playMode":
        this.patchMedia(update.pid, (c) => { c.repeat = update.repeat; c.shuffle = update.shuffle; });
        return;
      case "repeatMode":
        this.patchMedia(update.pid, (c) => { c.repeat = update.repeat; });
        return;
      case "shuffleMode":
        this.patchMedia(update.pid, (c) => { c.shuffle = update.shuffle; });
        return;
      case "source":
        this.patchMedia(update.pid, (c) => { c.source = update.source; });
        return;
      case "nowPlaying":
        this.patchMedia(update.pid, (c) => {
          c.title = update.media.song ?? null;
          c.artist = update.media.artist ?? null;
          c.album = update.media.album ?? null;
          c.artworkUrl = update.media.imageUrl;
          // § Network Source Resolver — resolves the real active service (Spotify, Tidal,
          // TuneIn station name, …) from the spec's `sid` field instead of leaving `source`
          // unset for anything but a station. `null` means nothing verified applies; the
          // device's last explicit input selection (e.g. an AUX pick) is left alone rather
          // than overwritten with nothing.
          const resolved = resolveHeosSourceLabel({
            sourceId: update.media.sourceId,
            type: update.media.type,
            station: update.media.station,
          });
          if (resolved) c.source = resolved;
        });
        return;
      case "nowPlayingChanged":
        link.socket?.write(`${buildHeosCommand("player", "get_now_playing_media", { pid: update.pid })}\r\n`);
        return;
      case "progress":
        this.patchMedia(update.pid, (c) => { c.positionSec = update.positionSec; c.durationSec = update.durationSec; });
        return;
      case "queue": {
        const pending = update.sequence ? this.pendingQueue.get(update.sequence) : undefined;
        if (!pending) return; // unsolicited or already-timed-out get_queue reply — ignore
        clearTimeout(pending.timer);
        this.pendingQueue.delete(update.sequence!);
        pending.resolve(
          update.items.map((i) => ({ id: i.qid, title: i.song, artist: i.artist, album: i.album, artworkUrl: i.imageUrl })),
        );
        return;
      }
      case "players":
      case "playersChanged":
      case "error":
        return; // no per-device state change to surface
    }
  }

  private patchMedia(pid: string, patch: (cache: HeosMediaCache) => void): void {
    for (const b of this.bindings) {
      if (b.pid !== pid) continue;
      const cache = this.media.get(b.deviceId);
      if (!cache) continue;
      patch(cache);
      this.media.set(b.deviceId, cache);
      this.record(b.deviceId, "media", buildHeosMediaState(cache));
    }
  }

  private record(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState): void {
    recordCapabilityState(this.states, this.listeners, deviceId, capability, state);
  }
}
