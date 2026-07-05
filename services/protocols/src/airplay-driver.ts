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
import { mdnsBrowse, type MdnsService } from "./mdns.js";

/**
 * AirPlay 2 driver (§3). IMPORTANT shape note: AirPlay is a *streaming* protocol, not a
 * control API — to "play" you become the audio sender (RTSP setup + FairPlay/HomeKit
 * pairing + RTP + NTP timing). AirPlay 2 in particular needs SRP/Curve25519 pairing, a
 * heavy stack that's only partially open. So:
 *   • DISCOVERY is real here — receivers announce `_airplay._tcp` over Bonjour (mDNS).
 *   • CONTROL maps the Supreme `media` capability to an injectable {@link AirPlaySender}
 *     seam (start/stop the stream + RAOP volume). A real deployment supplies the sender
 *     (wrapping an AirPlay 2 streaming library); tests inject a fake. The mapping +
 *     discovery are unit-tested; the streaming/pairing stack is the integration point.
 */
const AIRPLAY_SERVICE = "_airplay._tcp.local";

export interface AirPlaySenderState {
  playing: boolean;
  volume: number; // 0..100
}
export interface AirPlaySender {
  /** Begin streaming to the receiver (Supreme as the audio source). */
  start(): Promise<void>;
  /** Stop streaming. */
  stop(): Promise<void>;
  /** RAOP volume during an active stream (0..100). */
  setVolume(percent: number): Promise<void>;
  getState(): Promise<AirPlaySenderState>;
}
/** Resolve a sender for a receiver address (IP / host). */
export type AirPlayConnect = (address: string) => Promise<AirPlaySender>;

export interface AirPlayDriverOptions {
  pollMs?: number;
  connect?: AirPlayConnect;
  mdns?: (serviceType: string) => Promise<MdnsService[]>;
}

interface AirPlayBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  sender: AirPlaySender;
}

export class AirPlayProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "airplay";
  private connected = false;
  private readonly opts: AirPlayDriverOptions;
  private readonly bindings: AirPlayBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: AirPlayDriverOptions = {}) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.connected = true;
    const period = this.opts.pollMs ?? 5000;
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
    if (binding.capability !== "media") throw new Error(`airplay: capability ${binding.capability} not supported (media)`);
    const connect = this.opts.connect ?? defaultAirPlayConnect;
    const sender = await connect(binding.address);
    this.bindings.push({ deviceId: binding.deviceId, capability: "media", sender });
    this.devices.add(binding.deviceId);
  }
  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`airplay: ${deviceId} not bound for ${command.capability}`);
    if (command.capability !== "media") throw new Error(`airplay: unsupported capability ${command.capability}`);
    switch (command.action) {
      case "play":
        await b.sender.start();
        break;
      case "pause":
      case "stop":
        await b.sender.stop();
        break;
      case "volume":
        if (typeof command.volume === "number") await b.sender.setVolume(command.volume);
        break;
      // next/previous/mute aren't meaningful for a raw AirPlay stream sink.
    }
    await this.refresh(b);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // Real mDNS discovery of AirPlay receivers.
    const browse = this.opts.mdns ?? mdnsBrowse;
    const services = await browse(AIRPLAY_SERVICE);
    return services.map((s) => ({
      backendId: s.addresses[0] ?? s.host,
      suggestedName: s.name.split(`.${AIRPLAY_SERVICE.replace(/^\./, "")}`)[0]?.replace(/\\032/g, " ") || `AirPlay ${s.host}`,
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
        // tolerate transient errors
      }
    }
  }

  private async refresh(b: AirPlayBinding): Promise<void> {
    const s = await b.sender.getState();
    this.record(b.deviceId, "media", {
      kind: "media",
      playback: s.playing ? "playing" : "stopped",
      volume: Math.max(0, Math.min(100, Math.round(s.volume))),
      muted: false,
      title: null,
      artist: null,
      source: "AirPlay",
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

async function defaultAirPlayConnect(_address: string): Promise<AirPlaySender> {
  throw new Error(
    "airplay: no sender configured — provide connect() (an AirPlay 2 streaming sender; the RTSP/pairing/RTP stack)",
  );
}
