import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import type {
  BackendStateEvent,
  DiscoveredDevice,
  IBackendAdapter,
  StateListener,
} from "./adapter.js";

/**
 * In-memory backend adapter for Phase-0 verification and tests.
 *
 * It implements the exact same {@link IBackendAdapter} contract as `HaAdapter`,
 * which lets the full Supreme stack — gateway → device service → SIL → adapter —
 * be exercised end-to-end (the Phase-0 exit criteria, §16/§19) without a live HA
 * or any hardware. Swapping this for `HaAdapter` changes nothing above the SIL.
 */
export class MockAdapter implements IBackendAdapter {
  readonly kind = "mock";
  private connected = false;
  private readonly listeners = new Set<StateListener>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly seedDevices: DiscoveredDevice[];

  constructor(seed?: DiscoveredDevice[]) {
    this.seedDevices = seed ?? [];
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return this.seedDevices;
  }

  async getState(deviceId: DeviceId, capability: CapabilityKind): Promise<CapabilityState | null> {
    return this.states.get(`${deviceId}:${capability}`) ?? null;
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.connected) throw new Error("mock adapter not connected");
    const next = this.apply(deviceId, command);
    if (next) {
      this.states.set(`${deviceId}:${command.capability}`, next);
      const event: BackendStateEvent = {
        deviceId,
        capability: command.capability,
        state: next,
        ts: new Date().toISOString(),
      };
      for (const l of this.listeners) l(event);
    }
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Compute the resulting state of applying a command (the "device" responds). */
  private apply(deviceId: DeviceId, command: CapabilityCommand): CapabilityState | null {
    const prev = this.states.get(`${deviceId}:${command.capability}`);
    switch (command.capability) {
      case "onoff":
        return { kind: "onoff", on: command.action === "on" ? true : command.action === "off" ? false : !(prev as { on?: boolean })?.on };
      case "brightness": {
        const level = command.level ?? (prev?.kind === "brightness" ? prev.level : 100);
        const on = command.action === "off" ? false : true;
        return { kind: "brightness", on, level };
      }
      case "color": {
        const base = prev?.kind === "color" ? prev : null;
        return {
          kind: "color",
          on: true,
          level: command.level ?? base?.level ?? 100,
          hue: command.hue ?? base?.hue ?? null,
          saturation: command.saturation ?? base?.saturation ?? null,
          kelvin: command.kelvin ?? base?.kelvin ?? null,
        };
      }
      case "position": {
        const position = command.position ?? (command.action === "open" ? 100 : command.action === "close" ? 0 : prev?.kind === "position" ? prev.position : 0);
        return { kind: "position", position, moving: false };
      }
      case "lock":
        return { kind: "lock", locked: command.action === "lock", jammed: false };
      case "temperature": {
        const base = prev?.kind === "temperature" ? prev : null;
        return {
          kind: "temperature",
          ambientC: base?.ambientC ?? 21,
          targetC: command.targetC ?? base?.targetC ?? 21,
          mode: command.mode ?? base?.mode ?? "auto",
        };
      }
      case "media": {
        const base = prev?.kind === "media" ? prev : null;
        const playback = command.action === "play" ? "playing" : command.action === "pause" ? "paused" : command.action === "stop" ? "stopped" : base?.playback ?? "idle";
        return {
          kind: "media",
          playback,
          volume: command.volume ?? base?.volume ?? 30,
          muted: command.action === "mute" ? true : command.action === "unmute" ? false : base?.muted ?? false,
          title: base?.title ?? null,
          artist: base?.artist ?? null,
          source: base?.source ?? null,
          artworkUrl: base?.artworkUrl ?? null,
        };
      }
    }
  }

  /** Test/seed helper: set an initial state without emitting a command. */
  seedState(deviceId: DeviceId, state: CapabilityState): void {
    this.states.set(`${deviceId}:${state.kind}`, state);
  }
}
