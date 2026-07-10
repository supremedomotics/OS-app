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
  parseHeosMessage,
  playbackFromHeosState,
  type HeosMediaCache,
} from "./heos-codec.js";
import { ReconnectScheduler } from "./avr-reconnect.js";
import { ssdpSearch, type SsdpResponse, type SsdpSearchOptions } from "./ssdp.js";

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
}

interface HeosLink {
  socket: net.Socket | null;
  buffer: string;
  reconnect: ReconnectScheduler;
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
  private readonly links = new Map<string, HeosLink>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly media = new Map<DeviceId, HeosMediaCache>();
  private readonly listeners = new Set<StateListener>();
  private readonly pendingQueue = new Map<
    string,
    { resolve: (items: MediaQueueItem[] | null) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private queueSequence = 0;

  constructor(opts: HeosDriverOptions = {}) {
    this.opts = opts;
    this.defaultPort = opts.port ?? 1255;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    for (const link of this.links.values()) {
      link.reconnect.stop();
      link.socket?.destroy();
    }
    this.links.clear();
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
    this.bindings.push({ deviceId: binding.deviceId, host, port, pid });
    this.devices.add(binding.deviceId);
    if (!this.media.has(binding.deviceId)) {
      this.media.set(binding.deviceId, {
        playback: "idle", volume: 0, muted: false, source: null, title: null, artist: null,
        artworkUrl: null, durationSec: null, positionSec: null, shuffle: null, repeat: null,
      });
    }
    if (this.connected) {
      const link = this.ensureLink(key, host, port);
      if (link.socket && !link.socket.destroyed && !link.socket.connecting) this.syncPid(link, pid);
    }
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) throw new Error(`heos: ${deviceId} not bound`);
    const cache = this.media.get(deviceId);
    const req = commandToHeos(command, b.pid, { repeat: cache?.repeat ?? "off", shuffle: cache?.shuffle ?? false });
    if (!req) throw new Error(`heos: unsupported command for ${command.capability}/${"action" in command ? command.action : "?"}`);
    const link = this.ensureLink(`${b.host}:${b.port}`, b.host, b.port);
    link.socket?.write(`${buildHeosCommand(req.group, req.command, req.params)}\r\n`);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // Real SSDP discovery: HEOS speakers answer this Denon-defined search target
    // (spec §2.1: ST = urn:schemas-denon-com:device:ACT-Denon:1).
    const search = this.opts.ssdp ?? ssdpSearch;
    const responses = await search({ st: "urn:schemas-denon-com:device:ACT-Denon:1" });
    return responses.map((r) => ({
      backendId: r.address,
      suggestedName: `HEOS ${r.address}`,
      capabilities: ["media"] as DiscoveredDevice["capabilities"],
      raw: { server: r.server ?? null, location: r.location ?? null },
    }));
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
    const link = this.ensureLink(`${b.host}:${b.port}`, b.host, b.port);
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
      socket.write(`${buildHeosCommand("player", "get_queue", { pid: b.pid, range: "0,49", sequence })}\r\n`);
    });
  }

  private ensureLink(key: string, host: string, port: number): HeosLink {
    let link = this.links.get(key);
    if (link?.socket && !link.socket.destroyed) return link;
    if (link) {
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

  private openSocket(link: HeosLink, host: string, port: number): void {
    const socket = this.opts.createSocket ? this.opts.createSocket(host, port) : net.connect(port, host);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(`${host}:${port}`, chunk));
    socket.on("connect", () => {
      link.reconnect.reset();
      // Driver-init sequence per spec §2.1.1: un-register events, sync every bound
      // player's current state, then register for change events.
      socket.write(`${buildHeosCommand("system", "register_for_change_events", { enable: "off" })}\r\n`);
      for (const pid of this.pidsFor(host, port)) this.syncPid(link, pid);
      socket.write(`${buildHeosCommand("system", "register_for_change_events", { enable: "on" })}\r\n`);
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

  private pidsFor(host: string, port: number): string[] {
    return [...new Set(this.bindings.filter((b) => b.host === host && b.port === port).map((b) => b.pid))];
  }

  private syncPid(link: HeosLink, pid: string): void {
    if (!link.socket) return;
    const queries = [
      buildHeosCommand("player", "get_play_state", { pid }),
      buildHeosCommand("player", "get_volume", { pid }),
      buildHeosCommand("player", "get_mute", { pid }),
      buildHeosCommand("player", "get_play_mode", { pid }),
      buildHeosCommand("player", "get_now_playing_media", { pid }),
    ];
    for (const q of queries) link.socket.write(`${q}\r\n`);
  }

  private onData(key: string, chunk: string): void {
    const link = this.links.get(key);
    if (!link) return;
    link.buffer += chunk;
    const lines = link.buffer.split("\r\n");
    link.buffer = lines.pop() ?? "";
    for (const line of lines) this.onLine(link, line);
  }

  private onLine(link: HeosLink, line: string): void {
    const update = parseHeosMessage(line);
    if (!update) return;
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
          c.artworkUrl = update.media.imageUrl;
          if (update.media.type === "station" && update.media.station) c.source = update.media.station;
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
    const k = bindingKey(deviceId, capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) {
      l({ deviceId, capability, state, ts: new Date().toISOString() });
    }
  }
}

function parseHostPort(address: string, defaultPort: number): { host: string; port: number } {
  const [host, port] = address.split(":");
  return { host: host || address, port: Number(port ?? defaultPort) };
}
