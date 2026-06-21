import type { SonosConnect, SonosPlayer, SonosPlayerState } from "./sonos-driver.js";

/**
 * Real Sonos transport (§3) — backs the {@link SonosConnect} seam with the `sonos`
 * (node-sonos) library, which speaks the player's local UPnP/SOAP control on port 1400.
 * The library is an OPTIONAL dependency loaded dynamically + lazily (only when a Sonos
 * device is actually bound), so the package builds and runs without it installed. The
 * SOAP framing lives in node-sonos; the mapping below is the real, unit-tested IP.
 */

/** The slice of a node-sonos device we use (kept structural so we can fake it in tests). */
export interface SonosDevice {
  play(): Promise<unknown>;
  pause(): Promise<unknown>;
  stop(): Promise<unknown>;
  next(): Promise<unknown>;
  previous(): Promise<unknown>;
  setVolume(volume: number): Promise<unknown>;
  setMuted(muted: boolean): Promise<unknown>;
  getVolume(): Promise<number>;
  getMuted(): Promise<boolean>;
  getCurrentState(): Promise<string>;
  currentTrack(): Promise<{ title?: string; artist?: string } | null>;
}

/** node-sonos getCurrentState() → Supreme playback. */
export function mapSonosPlayback(state: string): SonosPlayerState["playback"] {
  switch (state) {
    case "playing":
    case "transitioning":
      return "playing";
    case "paused":
      return "paused";
    case "stopped":
      return "stopped";
    default:
      return "idle"; // "no_media_present" et al.
  }
}

/** Adapt a node-sonos device to the driver's {@link SonosPlayer} contract. */
export function wrapSonosDevice(device: SonosDevice): SonosPlayer {
  return {
    play: () => device.play().then(() => undefined),
    pause: () => device.pause().then(() => undefined),
    stop: () => device.stop().then(() => undefined),
    next: () => device.next().then(() => undefined),
    previous: () => device.previous().then(() => undefined),
    setVolume: (percent) => device.setVolume(Math.max(0, Math.min(100, Math.round(percent)))).then(() => undefined),
    setMute: (muted) => device.setMuted(muted).then(() => undefined),
    getState: async (): Promise<SonosPlayerState> => {
      const [state, volume, muted, track] = await Promise.all([
        device.getCurrentState().catch(() => "stopped"),
        device.getVolume().catch(() => 0),
        device.getMuted().catch(() => false),
        device.currentTrack().catch(() => null),
      ]);
      return {
        playback: mapSonosPlayback(state),
        volume,
        muted,
        title: track?.title ?? null,
        artist: track?.artist ?? null,
      };
    },
  };
}

interface SonosModule {
  Sonos: new (host: string, port?: number) => SonosDevice;
}

/**
 * A {@link SonosConnect} backed by node-sonos. `address` is the player's IP (optionally
 * `ip:port`). Pass this to `SonosProtocolDriver({ connect })` to drive real players.
 */
export function createSonosConnect(): SonosConnect {
  return async (address: string): Promise<SonosPlayer> => {
    const moduleName = "sonos";
    const mod = (await import(moduleName)) as unknown as SonosModule;
    const [host, port] = address.split(":");
    const device = new mod.Sonos(host || address, port ? Number(port) : undefined);
    return wrapSonosDevice(device);
  };
}
