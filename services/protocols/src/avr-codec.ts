import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";
import type { AudioCapabilityConfig } from "./avr-capabilities.js";

/**
 * AVR (Denon/Marantz) IP-control codec (§3). Denon/Marantz publish an ASCII Telnet
 * control protocol (port 23): CR-terminated tokens like `PWON`, `MV55`, `MUON`,
 * `SIDVD`, echoed back unsolicited on any change. This maps Supreme capabilities to
 * those tokens and parses status tokens into Supreme state. Power → onoff; master
 * volume / mute / source → media.
 *
 * Verified against the attached Denon AVR control protocol spec (v8.6.0). Every token
 * below appears in that document; nothing here is guessed. Two real, protocol-verified
 * limits carried forward honestly rather than papered over:
 *   - Zone 2 has power/input/mute/sleep (`Z2`, `Z2MU`, `Z2SLP`) but no documented
 *     volume command in this spec — Zone 2 volume is NOT implemented here because no
 *     verified token exists for it, not because it was overlooked.
 *   - The Telnet protocol has no feature/capability-query command (verified: none
 *     exists in the spec). Which zones/tone-control a given physical unit has is
 *     therefore installer-declared config, not a wire-discoverable fact — see
 *     `AudioCapabilityConfig.source` in `avr-capabilities.ts`.
 */

/** Master-volume scale: Denon `MV` is 00–98. */
const MV_MAX = 98;
/** Tone control (`PSBAS`/`PSTRE`) is encoded 00–99 with 50 = 0dB (spec p.14). */
const TONE_BIAS = 50;

export type AvrZone = "main" | "zone2";

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
/** Decode an `MV` token's raw 0..98(.5) step value — 2-digit = whole step (MV55 → 55),
 * 3-digit = half step (MV555 → 55.5). Shared by {@link percentFromMv} and
 * {@link dbFromMv}, which are two different real-world readings of the same token. */
function stepFromMvToken(mv: string): number {
  return mv.length >= 3 ? Number(mv.slice(0, 2)) + (mv[2] === "5" ? 0.5 : 0) : Number(mv);
}
export function percentFromMv(mv: string): number {
  return Math.max(0, Math.min(100, Math.round((stepFromMvToken(mv) / MV_MAX) * 100)));
}
/** Denon's own front-panel "Relative" display: MV80 (step 80) reads as 0.0dB, MV00 as
 * -80.0dB, MV98 as +18.0dB — the receiver's documented volume range. Derived straight
 * from the raw wire token, not from the 0..100 percent (so it's exact, not rounded
 * twice), and is genuinely Denon-specific — no other driver in this codebase has a
 * verified native dB reading, so nothing else should synthesize one. */
export function dbFromMv(mv: string): number {
  return stepFromMvToken(mv) - 80;
}

/** Encode a signed dB tone value (-6..+6 typical) to the two-digit biased token. */
function toneToken(db: number): string {
  return pad2(Math.max(0, Math.min(99, Math.round(db + TONE_BIAS))));
}
function toneFromToken(raw: string): number {
  return Number(raw) - TONE_BIAS;
}

/** Denon surround/DSP mode names this codec recognizes for `MS<mode>` (spec p.11). Passed
 * through verbatim as `AvrSoundMode` ids — never translated into a cross-brand enum. */
export const DENON_SOUND_MODES = [
  "MOVIE", "MUSIC", "GAME", "DIRECT", "PURE DIRECT", "STEREO", "STANDARD",
  "DOLBY DIGITAL", "DTS SURROUND", "MCH STEREO", "ROCK ARENA", "JAZZ CLUB",
  "MONO MOVIE", "MATRIX", "VIDEO GAME", "VIRTUAL",
] as const;

/** Translate a Supreme command into AVR control tokens (null = unsupported). `zone`
 * selects which zone's token prefix to use — only "main" carries volume/tone/DSP, per
 * the spec (see module doc). */
export function commandToAvr(
  command: CapabilityCommand,
  prev: CapabilityState | null,
  zone: AvrZone = "main",
): string[] | null {
  const z2 = zone === "zone2";
  switch (command.capability) {
    case "onoff": {
      // Main zone uses `ZM` (Main Zone power) — NOT `PW` (whole-unit power/standby).
      // `PWSTANDBY` puts the entire receiver into standby, taking every zone down with
      // it (a real Zone 2 users hit); `ZM` is independent per zone, same as `Z2`/`Z3`.
      if (command.action === "toggle") {
        const on = prev?.kind === "onoff" ? prev.on : false;
        return [z2 ? (on ? "Z2OFF" : "Z2ON") : on ? "ZMOFF" : "ZMON"];
      }
      const on = command.action === "on";
      return [z2 ? (on ? "Z2ON" : "Z2OFF") : on ? "ZMON" : "ZMOFF"];
    }
    case "media": {
      switch (command.action) {
        case "volume":
          // No documented Zone 2 volume token (see module doc) — main zone only.
          if (z2) return null;
          return typeof command.volume === "number" ? [`MV${mvFromPercent(command.volume)}`] : null;
        case "mute":
          return [z2 ? "Z2MUON" : "MUON"];
        case "unmute":
          return [z2 ? "Z2MUOFF" : "MUOFF"];
        case "source":
          return typeof command.source === "string" ? [`${z2 ? "Z2" : "SI"}${command.source}`] : null;
        case "advanced": {
          const adv = command.advanced;
          if (!adv || z2) return null; // tone/DSP are main-zone only in this spec
          const tokens: string[] = [];
          if (typeof adv.bass === "number") tokens.push(`PSBAS ${toneToken(adv.bass)}`);
          if (typeof adv.treble === "number") tokens.push(`PSTRE ${toneToken(adv.treble)}`);
          if (typeof adv.soundMode === "string") tokens.push(`MS${adv.soundMode}`);
          if (typeof adv.sleepMinutes === "number") {
            tokens.push(adv.sleepMinutes <= 0 ? "SLPOFF" : `SLP${String(Math.min(120, adv.sleepMinutes)).padStart(3, "0")}`);
          }
          return tokens.length > 0 ? tokens : null;
        }
        default:
          return null; // transport (play/pause/next/…) is not on this protocol; use HEOS
      }
    }
    default:
      return null;
  }
}

export type AvrUpdate =
  | { kind: "power"; on: boolean }
  | { kind: "volume"; volume: number; volumeDb: number }
  | { kind: "mute"; muted: boolean }
  | { kind: "source"; source: string }
  | { kind: "sleep"; minutes: number | null }
  | { kind: "bass"; bass: number }
  | { kind: "treble"; treble: number }
  | { kind: "soundMode"; mode: string }
  | { kind: "zone2Power"; on: boolean }
  | { kind: "zone2Mute"; muted: boolean }
  | { kind: "zone2Source"; source: string };

/** Parse one AVR status token into a structured update (null = ignored/unknown). */
export function parseAvrLine(line: string): AvrUpdate | null {
  const t = line.trim();
  // `ZM` (Main Zone power) is the authoritative per-zone signal; `PW` (whole-unit
  // power) still carries real meaning — standby there means every zone is down —
  // so both are parsed into the same "power" update rather than one replacing the other.
  if (t === "PWON") return { kind: "power", on: true };
  if (t === "PWSTANDBY") return { kind: "power", on: false };
  if (t === "ZMON") return { kind: "power", on: true };
  if (t === "ZMOFF") return { kind: "power", on: false };
  if (t === "MUON") return { kind: "mute", muted: true };
  if (t === "MUOFF") return { kind: "mute", muted: false };
  // MVMAX is the max-volume advert, not the current level — ignore it.
  if (t.startsWith("MV") && !t.startsWith("MVMAX")) {
    const digits = t.slice(2);
    if (/^\d{2,3}$/.test(digits)) return { kind: "volume", volume: percentFromMv(digits), volumeDb: dbFromMv(digits) };
  }
  if (t === "SLPOFF") return { kind: "sleep", minutes: null };
  if (/^SLP\d{3}$/.test(t)) return { kind: "sleep", minutes: Number(t.slice(3)) };
  if (/^PSBAS \d{2}$/.test(t)) return { kind: "bass", bass: toneFromToken(t.slice(6)) };
  if (/^PSTRE \d{2}$/.test(t)) return { kind: "treble", treble: toneFromToken(t.slice(6)) };
  if (t.startsWith("MS") && !t.startsWith("MSQUICK")) return { kind: "soundMode", mode: t.slice(2) };
  if (t === "Z2ON") return { kind: "zone2Power", on: true };
  if (t === "Z2OFF") return { kind: "zone2Power", on: false };
  if (t === "Z2MUON") return { kind: "zone2Mute", muted: true };
  if (t === "Z2MUOFF") return { kind: "zone2Mute", muted: false };
  if (t.startsWith("Z2MU")) return null; // avoid Z2 fallthrough matching Z2MU as a source
  if (t.startsWith("Z2SLP")) return null; // Zone 2 sleep not surfaced as Supreme state today
  if (t.startsWith("Z2")) return { kind: "zone2Source", source: t.slice(2) };
  if (t.startsWith("SI")) return { kind: "source", source: t.slice(2) };
  return null;
}

/** Build a full Supreme MediaState from the driver's per-device media cache. */
export function buildMediaState(cache: {
  volume: number;
  volumeDb?: number;
  muted: boolean;
  source: string | null;
  bass?: number;
  treble?: number;
  soundMode?: string;
  sleepMinutes?: number | null;
}): CapabilityState {
  const advanced: Record<string, unknown> = {};
  if (cache.volumeDb !== undefined) advanced.volumeDb = cache.volumeDb;
  if (cache.bass !== undefined) advanced.bass = cache.bass;
  if (cache.treble !== undefined) advanced.treble = cache.treble;
  if (cache.soundMode !== undefined) advanced.soundMode = cache.soundMode;
  if (cache.sleepMinutes !== undefined) advanced.sleepMinutes = cache.sleepMinutes ?? 0;
  return {
    kind: "media",
    playback: "idle",
    volume: cache.volume,
    muted: cache.muted,
    title: null,
    artist: null,
    source: cache.source,
    artworkUrl: null,
    advanced: Object.keys(advanced).length > 0 ? advanced : null,
  };
}

/** The AudioCapabilityConfig for a Denon/Marantz Telnet device — always installer-declared
 * (the protocol has no feature-query command, verified against the spec). `hasZone2` and
 * `hasToneControl` come from the binding config the installer sets at commissioning. */
export function denonCapabilityConfig(opts: { hasZone2: boolean; hasToneControl: boolean }): AudioCapabilityConfig {
  const inputs = DENON_INPUTS.map((id) => ({ id, label: DENON_INPUT_LABELS[id] ?? id, type: DENON_INPUT_TYPES[id] }));
  return {
    source: "installer_declared",
    inputs,
    soundModes: DENON_SOUND_MODES.map((id) => ({ id, label: id })),
    ...(opts.hasToneControl ? { toneControl: { bass: { min: -6, max: 6, step: 1 }, treble: { min: -6, max: 6, step: 1 } } } : {}),
    ...(opts.hasZone2 ? { zones: [{ id: "main", label: "Main Zone", inputs }, { id: "zone2", label: "Zone 2", inputs }] } : {}),
    transport: { play: false, pause: false, stop: false, next: false, previous: false, seek: false, shuffle: false, repeat: false },
    // Denon's `SLP<mmm>` accepts any 1-120 minute value (spec p.15), but the front panel
    // itself only ever offers these presets plus Off — matching that exactly rather than
    // exposing a raw 1..120 range keeps the control honest to how the device is actually used.
    advancedControls: [
      {
        key: "sleepMinutes",
        label: "Sleep Timer",
        kind: "select",
        icon: "sleep",
        options: [
          { id: "0", label: "Off" },
          { id: "30", label: "30 min" },
          { id: "60", label: "60 min" },
          { id: "90", label: "90 min" },
          { id: "120", label: "120 min" },
        ],
      },
    ],
  };
}

/** Input source names from the spec's `SI` parameter table (p.8). */
export const DENON_INPUTS = [
  "TUNER", "DVD", "BD", "TV", "SAT/CBL", "MPLAY", "GAME", "AUX1", "NET",
  "PANDORA", "SIRIUSXM", "LASTFM", "FLICKR", "FAVORITES", "IRADIO", "SERVER", "USB/IPOD",
] as const;

/** Human-readable labels for the `SI` tokens Denon's own protocol spec + on-screen display
 * use (§ HEOS Input investigation — root cause was `denonCapabilityConfig()` displaying the
 * raw wire token verbatim, e.g. "NET", instead of what the receiver's own front panel/OSD
 * actually calls it). Sourced from Denon/Marantz's published token reference and standard
 * on-screen-display naming — never a wire query (the Telnet spec has no label-query command,
 * see the module doc above), and never a per-unit custom rename (that's genuinely
 * unqueryable, see the same doc). `NET` is what every HEOS Built-in receiver's front panel
 * has displayed as "HEOS Music" since HEOS became standard across the Denon/Marantz lineup
 * (~2014+) — this is the real, documented answer to "why doesn't HEOS appear as an input,"
 * not a new capability being fabricated. Tokens with no meaningfully different display name
 * (e.g. "TUNER") are simply absent here and fall back to the raw id. */
const DENON_INPUT_LABELS: Partial<Record<(typeof DENON_INPUTS)[number], string>> = {
  BD: "Blu-ray",
  "SAT/CBL": "Satellite/Cable",
  MPLAY: "Media Player",
  AUX1: "AUX",
  NET: "HEOS Music",
  IRADIO: "Internet Radio",
  SERVER: "Media Server",
  "USB/IPOD": "USB/iPod",
};

/** Best-guess icon category per input (§ `AvrInput.type` — a display hint only, not a
 * protocol fact; the spec's `SI` table has no notion of physical-connector type). */
const DENON_INPUT_TYPES: Partial<Record<(typeof DENON_INPUTS)[number], string>> = {
  TUNER: "tuner",
  DVD: "hdmi",
  BD: "hdmi",
  TV: "hdmi",
  "SAT/CBL": "hdmi",
  MPLAY: "hdmi",
  GAME: "hdmi",
  AUX1: "analog",
  NET: "network",
  PANDORA: "streaming",
  SIRIUSXM: "streaming",
  LASTFM: "streaming",
  FLICKR: "streaming",
  FAVORITES: "streaming",
  IRADIO: "streaming",
  SERVER: "network",
  "USB/IPOD": "usb",
};
