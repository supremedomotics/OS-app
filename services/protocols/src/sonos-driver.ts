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

/**
 * Sonos transport seam. Sonos local control is UPnP/SOAP on the player (port 1400);
 * the SOAP/XML framing lives in the transport (a real impl wraps `node-sonos` or raw
 * SOAP), so the capability mapping here is transport-agnostic and unit-testable.
 */
export interface SonosPlayerState {
  playback: "playing" | "paused" | "stopped" | "idle";
  volume: number;
  muted: boolean;
  title: string | null;
  artist: string | null;
}
export interface SonosPlayer {
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  setVolume(percent: number): Promise<void>;
  setMute(muted: boolean): Promise<void>;
  getState(): Promise<SonosPlayerState>;
}
/** Resolve a player handle for a given Sonos address (room name / IP). */
export type SonosConnect = (address: string) => Promise<SonosPlayer>;

export interface SonosDriverOptions {
  pollMs?: number;
  connect?: SonosConnect;
}

interface SonosBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  player: SonosPlayer;
}

/**
 * Real Sonos driver (§3) — multi-room audio over local UPnP. Each player binds by room
 * name / IP; commands map to the player's transport, state is polled. Emits the Supreme
 * `media` capability. (Grouping/stereo-pairs are a follow-on.)
 */
export class SonosProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "sonos";
  private connected = false;
  private readonly opts: SonosDriverOptions;
  private readonly bindings: SonosBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SonosDriverOptions = {}) {
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
    const connect = this.opts.connect ?? defaultSonosConnect;
    const player = await connect(binding.address);
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, player });
    this.devices.add(binding.deviceId);
  }
  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`sonos: ${deviceId} not bound for ${command.capability}`);
    if (command.capability !== "media") throw new Error(`sonos: unsupported capability ${command.capability}`);
    const p = b.player;
    switch (command.action) {
      case "play": await p.play(); break;
      case "pause": await p.pause(); break;
      case "stop": await p.stop(); break;
      case "next": await p.next(); break;
      case "previous": await p.previous(); break;
      case "volume": if (typeof command.volume === "number") await p.setVolume(command.volume); break;
      case "mute": await p.setMute(true); break;
      case "unmute": await p.setMute(false); break;
    }
    // Reflect promptly; the next poll confirms.
    await this.refresh(b);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return []; // SSDP discovery of Sonos players is a follow-on
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
        // tolerate transient errors
      }
    }
  }

  private async refresh(b: SonosBinding): Promise<void> {
    const s = await b.player.getState();
    this.record(b.deviceId, "media", {
      kind: "media",
      playback: s.playback,
      volume: Math.max(0, Math.min(100, Math.round(s.volume))),
      muted: s.muted,
      title: s.title,
      artist: s.artist,
      source: null,
      artworkUrl: null,
    });
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

async function defaultSonosConnect(_address: string): Promise<SonosPlayer> {
  throw new Error("sonos: no transport configured — provide connect() (e.g. wrapping node-sonos / UPnP SOAP)");
}
