import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";

/**
 * AVR (Denon/Marantz) IP-control codec (§3). Denon/Marantz publish an ASCII Telnet
 * control protocol (port 23): CR-terminated tokens like `PWON`, `MV55`, `MUON`,
 * `SIDVD`, echoed back unsolicited on any change. This maps Supreme capabilities to
 * those tokens and parses status tokens into Supreme state. Power → onoff; master
 * volume / mute / source → media.
 */

/** Master-volume scale: Denon `MV` is 00–98. */
const MV_MAX = 98;

export function parseHostPort(address: string, defaultPort = 23): { host: string; port: number } {
  const [host, port] = address.split(":");
  return { host: host || address, port: Number(port ?? defaultPort) };
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
export function mvFromPercent(pct: number): string {
  return pad2(Math.max(0, Math.min(MV_MAX, Math.round((pct / 100) * MV_MAX))));
}
export function percentFromMv(mv: string): number {
  // 2-digit = whole step (MV55 → 55); 3-digit = half step (MV555 → 55.5).
  const n = mv.length >= 3 ? Number(mv.slice(0, 2)) + (mv[2] === "5" ? 0.5 : 0) : Number(mv);
  return Math.max(0, Math.min(100, Math.round((n / MV_MAX) * 100)));
}

/** Translate a Supreme command into AVR control tokens (null = unsupported). */
export function commandToAvr(command: CapabilityCommand, prev: CapabilityState | null): string[] | null {
  switch (command.capability) {
    case "onoff": {
      if (command.action === "toggle") {
        const on = prev?.kind === "onoff" ? prev.on : false;
        return [on ? "PWSTANDBY" : "PWON"];
      }
      return [command.action === "on" ? "PWON" : "PWSTANDBY"];
    }
    case "media": {
      switch (command.action) {
        case "volume":
          return typeof command.volume === "number" ? [`MV${mvFromPercent(command.volume)}`] : null;
        case "mute":
          return ["MUON"];
        case "unmute":
          return ["MUOFF"];
        default:
          return null; // transport (play/pause/next/…) is source-specific; not mapped
      }
    }
    default:
      return null;
  }
}

export type AvrUpdate =
  | { kind: "power"; on: boolean }
  | { kind: "volume"; volume: number }
  | { kind: "mute"; muted: boolean }
  | { kind: "source"; source: string };

/** Parse one AVR status token into a structured update (null = ignored/unknown). */
export function parseAvrLine(line: string): AvrUpdate | null {
  const t = line.trim();
  if (t === "PWON") return { kind: "power", on: true };
  if (t === "PWSTANDBY") return { kind: "power", on: false };
  if (t === "MUON") return { kind: "mute", muted: true };
  if (t === "MUOFF") return { kind: "mute", muted: false };
  // MVMAX is the max-volume advert, not the current level — ignore it.
  if (t.startsWith("MV") && !t.startsWith("MVMAX")) {
    const digits = t.slice(2);
    if (/^\d{2,3}$/.test(digits)) return { kind: "volume", volume: percentFromMv(digits) };
  }
  if (t.startsWith("SI")) return { kind: "source", source: t.slice(2) };
  return null;
}

/** Build a full Supreme MediaState from the driver's per-device media cache. */
export function buildMediaState(cache: { volume: number; muted: boolean; source: string | null }): CapabilityState {
  return {
    kind: "media",
    playback: "idle",
    volume: cache.volume,
    muted: cache.muted,
    title: null,
    artist: null,
    source: cache.source,
    artworkUrl: null,
  };
}
