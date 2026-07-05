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
  type MediaArtwork,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import { mdnsBrowse, type MdnsService } from "./mdns.js";

/**
 * Apple TV driver (§3) — full media control + rich "now playing" (foreground app and
 * its content) for a tvOS device.
 *
 * SHAPE NOTE (mirrors the AirPlay driver's honesty): Apple TV is controlled over the
 * **Media Remote Protocol (MRP)**, which since tvOS 15 is tunnelled over the AirPlay 2 /
 * Companion link with HAP-style pairing (SRP + Curve25519) and is fully encrypted. There
 * is no production-grade pure-Node MRP stack; the de-facto implementation is `pyatv`
 * (Python), which also needs per-device credentials obtained through an interactive
 * pairing flow. So:
 *   • DISCOVERY is real here — Apple TVs announce `_mediaremotetv._tcp` over Bonjour (mDNS).
 *   • CONTROL + NOW-PLAYING map the Supreme `media` capability to an injectable
 *     {@link AppleTvClient} seam. A real deployment supplies the client (wrapping pyatv with
 *     stored credentials — e.g. via the Python commissioning sidecar or an `atvremote`
 *     bridge); tests inject a fake. The mapping + discovery are unit-tested; the
 *     MRP/pairing transport is the integration point.
 *
 * The foreground app (Netflix, Disney+, Music, …) is surfaced as the Supreme media
 * `source`, and what's playing inside it as `title` / `artist` / `artworkUrl` — so clients
 * show "what app, playing what" with no contract change.
 */
const APPLE_TV_SERVICE = "_mediaremotetv._tcp.local";

/** A snapshot of what the Apple TV is doing, as reported by the MRP client (pyatv). */
export interface AppleTvNowPlaying {
  /** Transport state of the focused app. */
  state: "playing" | "paused" | "stopped" | "idle";
  /** Foreground app's display name, e.g. "Netflix" / "Apple TV" / "Music"; null if unknown. */
  app: string | null;
  /** Title of the current content (movie / show+episode / track); null when nothing plays. */
  title: string | null;
  /** Secondary line — artist for music, or show/series name for video; null if N/A. */
  artist: string | null;
  /** Artwork URL the clients can render (must be a URL or null — raw bytes aren't passed up). */
  artworkUrl: string | null;
  /** Output volume 0..100. */
  volume: number;
  /** Whether output is muted. */
  muted: boolean;
  /** True when the device has cover art available (fetched out-of-band via getArtwork). */
  hasArtwork?: boolean;
}

/** Control + state seam for one Apple TV. The real impl wraps pyatv (with credentials). */
export interface AppleTvClient {
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  /** Set output volume (0..100). */
  setVolume(percent: number): Promise<void>;
  /** Mute / unmute output. */
  setMuted(muted: boolean): Promise<void>;
  /** Current foreground app + content + transport. */
  nowPlaying(): Promise<AppleTvNowPlaying>;
  /** Optional: current cover-art bytes (null if none). */
  getArtwork?(): Promise<MediaArtwork | null>;
}

/** Resolve a client for an Apple TV address (IP / host), using stored MRP credentials. */
export type AppleTvConnect = (address: string) => Promise<AppleTvClient>;

export interface AppleTvDriverOptions {
  /** Poll period in ms for now-playing (default 4000). */
  pollMs?: number;
  /** Injectable client factory (tests inject a fake; prod wraps pyatv). */
  connect?: AppleTvConnect;
  /** Injectable mDNS browser (tests); defaults to a real multicast browse. */
  mdns?: (serviceType: string) => Promise<MdnsService[]>;
  /** Build the client-reachable artwork URL for a device (the gateway proxy path).
   * When set and the device has art, it's emitted as the media state's artworkUrl. */
  artworkUrlFor?: (deviceId: DeviceId) => string;
}

interface AppleTvBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  client: AppleTvClient;
}

/**
 * Map an Apple TV now-playing snapshot onto the Supreme `media` capability state. App →
 * `source` (with an "Apple TV" fallback so the source is never empty for a live device).
 */
export function mediaStateFromNowPlaying(
  np: AppleTvNowPlaying,
  artworkUrl: string | null = np.artworkUrl ?? null,
): CapabilityState {
  return {
    kind: "media",
    playback: np.state,
    volume: Math.max(0, Math.min(100, Math.round(np.volume))),
    muted: np.muted,
    title: np.title,
    artist: np.artist,
    source: np.app ?? "Apple TV",
    artworkUrl,
  };
}

export class AppleTvProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "appletv";
  private connected = false;
  private readonly opts: AppleTvDriverOptions;
  private readonly bindings: AppleTvBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: AppleTvDriverOptions = {}) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.connected = true;
    const period = this.opts.pollMs ?? 4000;
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
    if (binding.capability !== "media") {
      throw new Error(`appletv: capability ${binding.capability} not supported (media)`);
    }
    const connect = this.opts.connect ?? defaultAppleTvConnect;
    const client = await connect(binding.address);
    this.bindings.push({ deviceId: binding.deviceId, capability: "media", client });
    this.devices.add(binding.deviceId);
  }
  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`appletv: ${deviceId} not bound for ${command.capability}`);
    if (command.capability !== "media") throw new Error(`appletv: unsupported capability ${command.capability}`);
    switch (command.action) {
      case "play":
        await b.client.play();
        break;
      case "pause":
        await b.client.pause();
        break;
      case "stop":
        await b.client.stop();
        break;
      case "next":
        await b.client.next();
        break;
      case "previous":
        await b.client.previous();
        break;
      case "volume":
        if (typeof command.volume === "number") await b.client.setVolume(command.volume);
        break;
      case "mute":
        await b.client.setMuted(true);
        break;
      case "unmute":
        await b.client.setMuted(false);
        break;
    }
    await this.refresh(b);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // Real mDNS discovery: Apple TVs advertise the Media Remote service.
    const browse = this.opts.mdns ?? mdnsBrowse;
    const services = await browse(APPLE_TV_SERVICE);
    return services.map((s) => ({
      backendId: s.addresses[0] ?? s.host,
      suggestedName:
        s.name.split(`.${APPLE_TV_SERVICE.replace(/^\./, "")}`)[0]?.replace(/\\032/g, " ") ||
        (typeof s.txt?.Name === "string" ? s.txt.Name : `Apple TV ${s.host}`),
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
      try {
        await this.refresh(b);
      } catch {
        // A transient poll error on one device must not stop the others.
      }
    }
  }

  private async refresh(b: AppleTvBinding): Promise<void> {
    const np = await b.client.nowPlaying();
    // Cover art is fetched out-of-band (getArtwork); advertise the gateway proxy URL
    // only when art exists and a URL builder is configured, else null.
    const artworkUrl =
      np.hasArtwork && this.opts.artworkUrlFor ? this.opts.artworkUrlFor(b.deviceId) : np.artworkUrl ?? null;
    this.record(b.deviceId, "media", mediaStateFromNowPlaying(np, artworkUrl));
  }

  /** Fetch the bound device's current cover art (delegates to the client/bridge). */
  async getArtwork(deviceId: DeviceId): Promise<MediaArtwork | null> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b || !b.client.getArtwork) return null;
    return b.client.getArtwork();
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

async function defaultAppleTvConnect(_address: string): Promise<AppleTvClient> {
  throw new Error(
    "appletv: no client configured — provide connect() (a pyatv-backed MRP client with stored pairing credentials)",
  );
}
