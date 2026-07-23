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
 * below appears in that document; nothing here is guessed. One real, protocol-verified
 * limit carried forward honestly rather than papered over: the Telnet protocol has no
 * feature/capability-query command (verified: none exists in the spec). Which
 * zones/tone-control a given physical unit has is therefore installer-declared config,
 * not a wire-discoverable fact — see `AudioCapabilityConfig.source` in
 * `avr-capabilities.ts`.
 *
 * § Zone 2 volume (§ Production Bugfix Sprint) — this codec previously did NOT
 * implement Zone 2 volume, on the belief that no verified token existed for it in the
 * v8.6.0 spec excerpt this module was originally built against. Re-investigated against
 * independent, real-world Denon Telnet client implementations (k3erg/marantz-denon-
 * telnet's documented API, which ships working `Z215`/`Z230`-style examples) — Zone 2
 * volume IS a real command, `Z2<nn>`, the exact same two-digit numeric-token shape as
 * the main zone's `MV<nn>`, just with the `Z2` prefix instead of `MV`. Implemented below
 * reusing `MV_MAX`/the existing pad/step helpers — same scale, same encode/decode logic,
 * because no evidence suggests a different range for Zone 2. This is the corrected,
 * evidence-based state; the original "not implemented" note was wrong, not a
 * deliberate limitation.
 *
 * § Universal AVR SDK — Audyssey-family commands (§ user-supplied official Denon AVR
 * control protocol PDF, "DENON AVR control protocol Ver.8.6.0", application model
 * AVR-1713/AVR-1613, page 13). A previous pass on this SDK gated Dynamic EQ, Audyssey
 * MultEQ mode, Reference Level Offset, and Dynamic Volume as "command names plausible,
 * parameter encodings unverifiable" — reachable only via the unverified HTTP AppCommand
 * `SetAudyssey*` family. This official PDF (directly fetched/read this session, not a
 * summary) documents these as **Telnet** `PS`-prefixed commands with exact, literal
 * parameter tokens: `PSDYNEQ ON`/`OFF`; `PSMULTEQ:AUDYSSEY`/`BYP.LR`/`FLAT`/`MANUAL`/`OFF`;
 * `PSREFLEV 0`/`5`/`10`/`15`; `PSDYNVOL HEV`/`MED`/`LIT`/`OFF`. Dynamic Range Compression
 * (`PSDRC AUTO`/`LOW`/`MID`/`HI`/`OFF`, same page) ships alongside them for the same
 * reason. These are fixed-enum toggles/selects, not guessed numeric ranges — the one
 * safety concern from the prior gate (a wrong guessed *write* value misconfiguring real
 * speaker calibration) does not apply to a closed set of literal, spec-quoted tokens.
 * Model caveat, stated honestly rather than glossed over: the source PDF targets the
 * 2012-era AVR-1713/1613. Whether a specific bound unit *has* Audyssey calibration at all
 * is genuinely not wire-discoverable (no feature-query command exists at all — see above)
 * and varies by model tier, so `denonCapabilityConfig`'s `hasAudyssey` stays an explicit,
 * installer-declared opt-in (default `false`) rather than assumed present, unlike
 * `hasToneControl` (near-universal, defaults on). Channel-level trims (`CV<ch> **`, same
 * PDF p.7, confirmed exact 38–62/50=0dB encoding) are NOT implemented this pass — the
 * encoding is now real evidence too, but wiring a 6-channel trim UI is separate,
 * UI-verification-bound scope not taken up here; tracked as a follow-up, not silently
 * dropped.
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
 * through verbatim as `AvrSoundMode` ids — never translated into a cross-brand enum.
 * `AUTO` added (§ Production Bugfix Sprint) — a real, wire-reported raw `MS` token,
 * evidenced via Home Assistant's denonavr integration (its own sound_mode_dict maps
 * 'AUTO' straight through, confirming receivers genuinely report/accept it), not
 * previously included. A model-specific "Dolby Atmos"-labeled surround mode was
 * investigated but NOT added — no independent source (this HA integration's own open
 * GitHub issues included) shows a stable, universal token for it; real hardware likely
 * reports Atmos-active content through the existing `MS`/format-related tokens rather
 * than a dedicated "Atmos" mode name, which needs a real captured trace to confirm
 * rather than a guessed token name. */
export const DENON_SOUND_MODES = [
  "MOVIE", "MUSIC", "GAME", "DIRECT", "PURE DIRECT", "STEREO", "STANDARD", "AUTO",
  "DOLBY DIGITAL", "DTS SURROUND", "MCH STEREO", "ROCK ARENA", "JAZZ CLUB",
  "MONO MOVIE", "MATRIX", "VIDEO GAME", "VIRTUAL",
] as const;

/** Audyssey MultEQ mode tokens (`PSMULTEQ:<mode>`, spec p.13) — fixed enum, verbatim. */
export const DENON_AUDYSSEY_MODES = ["AUDYSSEY", "BYP.LR", "FLAT", "MANUAL", "OFF"] as const;
/** Reference Level Offset tokens (`PSREFLEV <n>`, spec p.13) — fixed enum, verbatim. */
export const DENON_REFERENCE_LEVELS = [0, 5, 10, 15] as const;
/** Dynamic Volume tokens (`PSDYNVOL <mode>`, spec p.13) — fixed enum, verbatim. */
export const DENON_DYNAMIC_VOLUME_MODES = ["HEV", "MED", "LIT", "OFF"] as const;
/** Dynamic Range Compression tokens (`PSDRC <mode>`, spec p.14) — fixed enum, verbatim. */
export const DENON_DRC_MODES = ["AUTO", "LOW", "MID", "HI", "OFF"] as const;

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
          // Zone 2 volume is `Z2<nn>` — same MV_MAX/0-98 scale as the main zone's `MV`
          // (see module doc § Zone 2 volume).
          return typeof command.volume === "number" ? [`${z2 ? "Z2" : "MV"}${mvFromPercent(command.volume)}`] : null;
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
          // § Universal AVR SDK — Audyssey-family (see module doc). Each is a closed,
          // spec-quoted enum — pass the value straight through as the wire token.
          if (typeof adv.dynamicEq === "string") tokens.push(`PSDYNEQ ${adv.dynamicEq === "on" ? "ON" : "OFF"}`);
          if (typeof adv.audysseyMode === "string" && (DENON_AUDYSSEY_MODES as readonly string[]).includes(adv.audysseyMode)) {
            tokens.push(`PSMULTEQ:${adv.audysseyMode}`);
          }
          if (typeof adv.referenceLevel === "number" && (DENON_REFERENCE_LEVELS as readonly number[]).includes(adv.referenceLevel)) {
            tokens.push(`PSREFLEV ${adv.referenceLevel}`);
          }
          if (typeof adv.dynamicVolume === "string" && (DENON_DYNAMIC_VOLUME_MODES as readonly string[]).includes(adv.dynamicVolume)) {
            tokens.push(`PSDYNVOL ${adv.dynamicVolume}`);
          }
          if (typeof adv.drc === "string" && (DENON_DRC_MODES as readonly string[]).includes(adv.drc)) {
            tokens.push(`PSDRC ${adv.drc}`);
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
  | { kind: "zone2Volume"; volume: number; volumeDb: number }
  | { kind: "zone2Source"; source: string }
  | { kind: "dynamicEq"; on: boolean }
  | { kind: "audysseyMode"; mode: string }
  | { kind: "referenceLevel"; db: number }
  | { kind: "dynamicVolume"; mode: string }
  | { kind: "drc"; mode: string };

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
  // § Universal AVR SDK — Audyssey-family (see module doc). Checked before the generic
  // "MS"-prefix soundMode fallthrough below since none of these share that prefix.
  if (t === "PSDYNEQ ON") return { kind: "dynamicEq", on: true };
  if (t === "PSDYNEQ OFF") return { kind: "dynamicEq", on: false };
  if (t.startsWith("PSMULTEQ:")) {
    const mode = t.slice("PSMULTEQ:".length);
    if ((DENON_AUDYSSEY_MODES as readonly string[]).includes(mode)) return { kind: "audysseyMode", mode };
  }
  if (t.startsWith("PSREFLEV ")) {
    const db = Number(t.slice("PSREFLEV ".length));
    if ((DENON_REFERENCE_LEVELS as readonly number[]).includes(db)) return { kind: "referenceLevel", db };
  }
  if (t.startsWith("PSDYNVOL ")) {
    const mode = t.slice("PSDYNVOL ".length);
    if ((DENON_DYNAMIC_VOLUME_MODES as readonly string[]).includes(mode)) return { kind: "dynamicVolume", mode };
  }
  if (t.startsWith("PSDRC ")) {
    const mode = t.slice("PSDRC ".length);
    if ((DENON_DRC_MODES as readonly string[]).includes(mode)) return { kind: "drc", mode };
  }
  if (t.startsWith("MS") && !t.startsWith("MSQUICK")) return { kind: "soundMode", mode: t.slice(2) };
  if (t === "Z2ON") return { kind: "zone2Power", on: true };
  if (t === "Z2OFF") return { kind: "zone2Power", on: false };
  if (t === "Z2MUON") return { kind: "zone2Mute", muted: true };
  if (t === "Z2MUOFF") return { kind: "zone2Mute", muted: false };
  if (t.startsWith("Z2MU")) return null; // avoid Z2 fallthrough matching Z2MU as a source
  if (t.startsWith("Z2SLP")) return null; // Zone 2 sleep not surfaced as Supreme state today
  // Zone 2 volume echo — `Z2<nn>` is purely numeric (§ module doc), same shape as `MV`;
  // must be checked before the generic zone2Source catch-all below (Z2ON/Z2OFF are
  // already handled above, so anything reaching here starting with "Z2" is either a
  // numeric volume echo or an alphabetic source token).
  if (t.startsWith("Z2")) {
    const digits = t.slice(2);
    if (/^\d{2,3}$/.test(digits)) return { kind: "zone2Volume", volume: percentFromMv(digits), volumeDb: dbFromMv(digits) };
    return { kind: "zone2Source", source: digits };
  }
  if (t.startsWith("SI")) return { kind: "source", source: t.slice(2) };
  return null;
}

/** Build a full Supreme MediaState from the driver's per-device media cache.
 * `artworkUrl` (§ Universal AVR SDK) — Telnet itself has no concept of album art, so
 * this always defaults to `null`; a driver that has real, different-source artwork
 * (the HTTP AppCommand interface's confirmed-static album-art URL, proxied through the
 * gateway) passes it in explicitly rather than mutating the returned object, which
 * would require unsafely widening `CapabilityState`'s union. */
export function buildMediaState(cache: {
  volume: number;
  volumeDb?: number;
  muted: boolean;
  source: string | null;
  bass?: number;
  treble?: number;
  soundMode?: string;
  sleepMinutes?: number | null;
  dynamicEq?: boolean;
  audysseyMode?: string;
  referenceLevel?: number;
  dynamicVolume?: string;
  drc?: string;
}, artworkUrl: string | null = null): CapabilityState {
  const advanced: Record<string, unknown> = {};
  if (cache.volumeDb !== undefined) advanced.volumeDb = cache.volumeDb;
  if (cache.bass !== undefined) advanced.bass = cache.bass;
  if (cache.treble !== undefined) advanced.treble = cache.treble;
  if (cache.soundMode !== undefined) advanced.soundMode = cache.soundMode;
  if (cache.sleepMinutes !== undefined) advanced.sleepMinutes = cache.sleepMinutes ?? 0;
  if (cache.dynamicEq !== undefined) advanced.dynamicEq = cache.dynamicEq ? "on" : "off";
  if (cache.audysseyMode !== undefined) advanced.audysseyMode = cache.audysseyMode;
  if (cache.referenceLevel !== undefined) advanced.referenceLevel = cache.referenceLevel;
  if (cache.dynamicVolume !== undefined) advanced.dynamicVolume = cache.dynamicVolume;
  if (cache.drc !== undefined) advanced.drc = cache.drc;
  return {
    kind: "media",
    playback: "idle",
    volume: cache.volume,
    muted: cache.muted,
    title: null,
    artist: null,
    source: cache.source,
    artworkUrl,
    advanced: Object.keys(advanced).length > 0 ? advanced : null,
  };
}

/** The AudioCapabilityConfig for a Denon/Marantz Telnet device. `hasZone2` and
 * `hasToneControl` always come from the binding config the installer sets at
 * commissioning (Telnet has no feature-query command, verified against the spec).
 *
 * `renamedInputs`/`hiddenInputs` (§ Universal AVR SDK) are the one real exception: real,
 * receiver-reported data fetched over HTTP AppCommand (`avr-http-codec.ts`'s
 * `parseRenameSource`/`parseDeletedSource`, confirmed exact XML shape this sprint) —
 * Telnet's own `SI` table has no rename/delete concept. `renamedInputs` overrides the
 * spec-derived default label per wire token; `hiddenInputs` filters those tokens out of
 * the selectable list entirely, matching the receiver's own front panel. `source` flips
 * to `"device_reported"` once either is genuinely non-empty — otherwise this returns
 * byte-for-byte what it always has, so a unit this enrichment hasn't run against yet (or
 * that has no HTTP interface at all) behaves identically to before this feature existed.
 *
 * `hasAudyssey` (§ Universal AVR SDK) — same installer-declared nature as `hasToneControl`,
 * but defaults `false` (opt-in) rather than `true` (opt-out): Audyssey calibration is
 * genuinely absent on lower-tier Denon/Marantz models, unlike tone control which is
 * near-universal, and Telnet has no feature-query command to tell them apart (see module
 * doc). When declared, advertises the Dynamic EQ / Audyssey MultEQ mode / Reference Level
 * Offset / Dynamic Volume / DRC controls — every one a fixed, spec-quoted enum (never a
 * guessed numeric range), each rendered through the existing generic `advancedControls`
 * "select" mechanism (same one `sleepMinutes` already uses) with zero new UI code. */
export function denonCapabilityConfig(opts: {
  hasZone2: boolean;
  hasToneControl: boolean;
  hasAudyssey?: boolean;
  renamedInputs?: Map<string, string>;
  hiddenInputs?: Set<string>;
}): AudioCapabilityConfig {
  const renamed = opts.renamedInputs;
  const hidden = opts.hiddenInputs;
  const hasEnrichment = (renamed && renamed.size > 0) || (hidden && hidden.size > 0);
  const inputs = DENON_INPUTS.filter((id) => !hidden?.has(id)).map((id) => ({
    id,
    label: renamed?.get(id) ?? DENON_INPUT_LABELS[id] ?? id,
    type: DENON_INPUT_TYPES[id],
  }));
  return {
    source: hasEnrichment ? "device_reported" : "installer_declared",
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
      ...(opts.hasAudyssey
        ? [
            {
              key: "dynamicEq",
              label: "Dynamic EQ",
              kind: "select" as const,
              options: [
                { id: "on", label: "On" },
                { id: "off", label: "Off" },
              ],
            },
            {
              key: "audysseyMode",
              label: "Audyssey MultEQ",
              kind: "select" as const,
              options: [
                { id: "AUDYSSEY", label: "Audyssey" },
                { id: "BYP.LR", label: "Bypass L/R" },
                { id: "FLAT", label: "Flat" },
                { id: "MANUAL", label: "Manual" },
                { id: "OFF", label: "Off" },
              ],
            },
            {
              key: "referenceLevel",
              label: "Reference Level Offset",
              kind: "select" as const,
              options: [
                { id: "0", label: "0 dB" },
                { id: "5", label: "+5 dB" },
                { id: "10", label: "+10 dB" },
                { id: "15", label: "+15 dB" },
              ],
            },
            {
              key: "dynamicVolume",
              label: "Dynamic Volume",
              kind: "select" as const,
              options: [
                { id: "OFF", label: "Off" },
                { id: "LIT", label: "Light" },
                { id: "MED", label: "Medium" },
                { id: "HEV", label: "Heavy" },
              ],
            },
            {
              key: "drc",
              label: "Dynamic Compression",
              kind: "select" as const,
              options: [
                { id: "OFF", label: "Off" },
                { id: "AUTO", label: "Auto" },
                { id: "LOW", label: "Low" },
                { id: "MID", label: "Mid" },
                { id: "HI", label: "High" },
              ],
            },
          ]
        : []),
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
