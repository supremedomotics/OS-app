import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";
import type { AudioCapabilityConfig, AvrRange } from "./avr-capabilities.js";
import { percentFromScale, scaleFromPercent } from "./avr-capabilities.js";

/**
 * Yamaha Extended Control (YXC) codec (§3) — the same HTTP+JSON API controls both
 * standalone MusicCast streamers (WXA-50, WX-021) and MusicCast-enabled AVRs
 * (RX-A8A); YXC's own spec Preface states it controls "MusicCast enabled devices",
 * so this is genuinely ONE protocol, not two. `<BaseURL>/v1/<zone|group>/<method>` GET
 * requests, flat JSON responses (`{"response_code":0, ...}`), unsolicited UDP-unicast
 * push events once a request carries `X-AppName`/`X-AppPort` headers.
 *
 * Verified against the attached Yamaha Extended Control API Specification (Basic) v1.10
 * — every URI, param, and enum below is taken from that document. One real,
 * protocol-verified asymmetry worth calling out (rather than smoothing over): unlike
 * Denon Telnet and HEOS CLI, Yamaha genuinely supports an absolute seek
 * (`netusb/setPlayPosition`, §7.4) — and genuinely does NOT support a direct
 * repeat/shuffle set, only `toggleRepeat`/`toggleShuffle` (§7.5/§7.6, no discrete
 * on/off command exists). Both facts are preserved here rather than faked one way or
 * the other.
 */

export const YAMAHA_ZONES = ["main", "zone2", "zone3", "zone4"] as const;
export type YamahaZone = (typeof YAMAHA_ZONES)[number];

export function isYamahaZone(v: string): v is YamahaZone {
  return (YAMAHA_ZONES as readonly string[]).includes(v);
}

export function yamahaBaseUrl(host: string): string {
  const h = host.startsWith("http") ? host.replace(/\/$/, "") : `http://${host}`;
  return `${h}/YamahaExtendedControl/v1`;
}

/** Build a full `<BaseURL>/v1/<group>/<method>?...` GET request URL. */
export function yamahaUrl(host: string, group: string, method: string, params: Record<string, string | number> = {}): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `${yamahaBaseUrl(host)}/${group}/${method}${qs ? `?${qs}` : ""}`;
}

export function yamahaAbsoluteUrl(host: string, relativeOrAbsolute: string): string {
  if (/^https?:\/\//.test(relativeOrAbsolute)) return relativeOrAbsolute;
  const h = host.startsWith("http") ? host.replace(/\/$/, "") : `http://${host}`;
  return `${h}${relativeOrAbsolute.startsWith("/") ? "" : "/"}${relativeOrAbsolute}`;
}

// ── /system/getFeatures — the genuine wire-level dynamic capability query ────────────

const PLAY_INFO_TYPES = ["none", "tuner", "netusb", "cd"] as const;
export type YamahaPlayInfoType = (typeof PLAY_INFO_TYPES)[number];

export interface YamahaInputInfo {
  id: string;
  /** Which zone-agnostic playback-info API (if any) reflects this input's now-playing
   * state — the driver uses this to decide whether to also pull `netusb/getPlayInfo`
   * for a zone currently tuned to this input. Genuinely queried, never guessed. */
  playInfoType: YamahaPlayInfoType;
}

export interface YamahaZoneFeatures {
  id: YamahaZone;
  funcList: string[];
  inputList: string[];
  soundProgramList: string[];
  volumeRange: AvrRange;
  toneRange?: AvrRange;
}

export interface YamahaFeatures {
  systemInputs: YamahaInputInfo[];
  zones: YamahaZoneFeatures[];
}

export function parseYamahaFeatures(json: Record<string, unknown>): YamahaFeatures {
  const system = (json.system ?? {}) as Record<string, unknown>;
  const systemInputs: YamahaInputInfo[] = Array.isArray(system.input_list)
    ? (system.input_list as Record<string, unknown>[]).map((i) => ({
        id: String(i.id),
        playInfoType: (PLAY_INFO_TYPES as readonly string[]).includes(String(i.play_info_type))
          ? (i.play_info_type as YamahaPlayInfoType)
          : "none",
      }))
    : [];
  const zonesRaw = Array.isArray(json.zone) ? (json.zone as Record<string, unknown>[]) : [];
  const zones: YamahaZoneFeatures[] = zonesRaw
    .filter((z) => isYamahaZone(String(z.id)))
    .map((z) => {
      const rangeStep = Array.isArray(z.range_step) ? (z.range_step as Record<string, unknown>[]) : [];
      const volume = rangeStep.find((r) => r.id === "volume");
      const tone = rangeStep.find((r) => r.id === "tone_control");
      return {
        id: z.id as YamahaZone,
        funcList: Array.isArray(z.func_list) ? (z.func_list as string[]) : [],
        inputList: Array.isArray(z.input_list) ? (z.input_list as string[]) : [],
        soundProgramList: Array.isArray(z.sound_program_list) ? (z.sound_program_list as string[]) : [],
        volumeRange: volume
          ? { min: Number(volume.min), max: Number(volume.max), step: Number(volume.step) }
          : { min: 0, max: 100, step: 1 },
        toneRange: tone ? { min: Number(tone.min), max: Number(tone.max), step: Number(tone.step) } : undefined,
      };
    });
  return { systemInputs, zones };
}

/** The AudioCapabilityConfig for one zone — `device_reported` because every field here
 * genuinely comes off the wire via `/system/getFeatures` (unlike Denon Telnet's
 * installer-declared fallback). */
export function yamahaCapabilityConfig(zf: YamahaZoneFeatures): AudioCapabilityConfig {
  const label = (id: string) => id.replace(/_/g, " ");
  return {
    source: "device_reported",
    inputs: zf.inputList.map((id) => ({ id, label: label(id) })),
    soundModes: zf.soundProgramList.map((id) => ({ id, label: label(id) })),
    volumeRange: zf.volumeRange,
    ...(zf.funcList.includes("tone_control") && zf.toneRange ? { toneControl: { bass: zf.toneRange, treble: zf.toneRange } } : {}),
    bluetooth: zf.inputList.includes("bluetooth"),
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────────

export interface YamahaRequest {
  /** Zone id for zone-scoped calls, or "netusb" for the device-global Net/USB transport
   * API (spec §7 — not zone-scoped on the wire; see module doc). */
  group: string;
  method: string;
  params: Record<string, string | number>;
}

export interface YamahaCommandContext {
  volumeRange: AvrRange;
}

const SLEEP_MINUTES = [0, 30, 60, 90, 120] as const;
function nearestSleepMinutes(requested: number): number {
  return SLEEP_MINUTES.reduce((best, candidate) => (Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best));
}

/** Returns an ARRAY because a single Supreme command can require multiple independent
 * HTTP calls (e.g. `advanced: {soundProgram, bass, treble}` hits both
 * `setSoundProgram` and `setToneControl` — unlike Denon's single Telnet write, each
 * Yamaha endpoint is its own request). Null = unsupported on this protocol. */
export function commandToYamaha(command: CapabilityCommand, zone: YamahaZone, ctx: YamahaCommandContext): YamahaRequest[] | null {
  switch (command.capability) {
    case "onoff": {
      const power = command.action === "toggle" ? "toggle" : command.action === "on" ? "on" : "standby";
      return [{ group: zone, method: "setPower", params: { power } }];
    }
    case "media": {
      switch (command.action) {
        case "play":
          return [{ group: "netusb", method: "setPlayback", params: { playback: "play" } }];
        case "pause":
          return [{ group: "netusb", method: "setPlayback", params: { playback: "pause" } }];
        case "stop":
          return [{ group: "netusb", method: "setPlayback", params: { playback: "stop" } }];
        case "next":
          return [{ group: "netusb", method: "setPlayback", params: { playback: "next" } }];
        case "previous":
          return [{ group: "netusb", method: "setPlayback", params: { playback: "previous" } }];
        case "volume":
          return typeof command.volume === "number"
            ? [{
                group: zone,
                method: "setVolume",
                params: { volume: scaleFromPercent(command.volume, ctx.volumeRange.min, ctx.volumeRange.max, ctx.volumeRange.step) },
              }]
            : null;
        case "mute":
          return [{ group: zone, method: "setMute", params: { enable: "true" } }];
        case "unmute":
          return [{ group: zone, method: "setMute", params: { enable: "false" } }];
        case "source":
          return typeof command.source === "string" ? [{ group: zone, method: "setInput", params: { input: command.source } }] : null;
        case "seek":
          // Real, wire-verified: netusb/setPlayPosition (Server input only, per spec §7.4).
          return typeof command.positionSec === "number"
            ? [{ group: "netusb", method: "setPlayPosition", params: { position: Math.max(0, Math.round(command.positionSec)) } }]
            : null;
        case "shuffle":
          // Toggle-only (verified: no discrete shuffle on/off command exists) — caller
          // (the driver) decides whether to fire this by comparing against cached state.
          return [{ group: "netusb", method: "toggleShuffle", params: {} }];
        case "repeat":
          // Toggle-only, cycling off/all/one in a device-defined order the spec does not
          // document — one toggle per command, same as pressing the remote's repeat key.
          return [{ group: "netusb", method: "toggleRepeat", params: {} }];
        case "advanced": {
          const adv = command.advanced;
          if (!adv) return null;
          const requests: YamahaRequest[] = [];
          if (typeof adv.soundProgram === "string") requests.push({ group: zone, method: "setSoundProgram", params: { program: adv.soundProgram } });
          if (typeof adv.bass === "number" || typeof adv.treble === "number") {
            const params: Record<string, string | number> = { mode: "manual" };
            if (typeof adv.bass === "number") params.bass = adv.bass;
            if (typeof adv.treble === "number") params.treble = adv.treble;
            requests.push({ group: zone, method: "setToneControl", params });
          }
          if (typeof adv.sleepMinutes === "number") {
            requests.push({ group: zone, method: "setSleep", params: { sleep: nearestSleepMinutes(adv.sleepMinutes) } });
          }
          return requests.length > 0 ? requests : null;
        }
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

// ── Status / now-playing parsing ─────────────────────────────────────────────────────

export interface YamahaZoneStatus {
  power: boolean;
  volume: number;
  muted: boolean;
  input: string;
  soundProgram?: string;
  bass?: number;
  treble?: number;
}

export function parseYamahaZoneStatus(json: Record<string, unknown>): YamahaZoneStatus {
  const tone = (json.tone_control ?? {}) as Record<string, unknown>;
  return {
    power: json.power === "on",
    volume: Number(json.volume ?? 0),
    muted: json.mute === true,
    input: typeof json.input === "string" ? json.input : "",
    soundProgram: typeof json.sound_program === "string" ? json.sound_program : undefined,
    bass: typeof tone.bass === "number" ? tone.bass : undefined,
    treble: typeof tone.treble === "number" ? tone.treble : undefined,
  };
}

export interface YamahaNetUsbPlayInfo {
  playback: "play" | "stop" | "pause" | "fast_reverse" | "fast_forward";
  repeat: "off" | "one" | "all";
  shuffle: "off" | "on" | "songs" | "albums";
  positionSec: number | null;
  durationSec: number | null;
  artist: string | null;
  album: string | null;
  track: string | null;
  artworkUrl: string | null;
  /** Raw playback-capability bit field (spec §7.2) — passed through for advanced UIs
   * rather than hardcoded into a fixed per-brand transport-capability shape. */
  attribute: number;
}

export function parseYamahaPlayInfo(json: Record<string, unknown>, host: string): YamahaNetUsbPlayInfo {
  const playTime = Number(json.play_time ?? -60000);
  const totalTime = Number(json.total_time ?? 0);
  const art = typeof json.albumart_url === "string" && json.albumart_url ? yamahaAbsoluteUrl(host, json.albumart_url) : null;
  const playback = typeof json.playback === "string" ? (json.playback as YamahaNetUsbPlayInfo["playback"]) : "stop";
  const repeat = typeof json.repeat === "string" ? (json.repeat as YamahaNetUsbPlayInfo["repeat"]) : "off";
  const shuffle = typeof json.shuffle === "string" ? (json.shuffle as YamahaNetUsbPlayInfo["shuffle"]) : "off";
  return {
    playback,
    repeat,
    shuffle,
    positionSec: playTime === -60000 ? null : playTime,
    durationSec: totalTime > 0 ? totalTime : null,
    artist: typeof json.artist === "string" ? json.artist : null,
    album: typeof json.album === "string" ? json.album : null,
    track: typeof json.track === "string" ? json.track : null,
    artworkUrl: art,
    attribute: Number(json.attribute ?? 0),
  };
}

export function playbackFromYamaha(p: YamahaNetUsbPlayInfo["playback"]): "playing" | "paused" | "stopped" | "idle" {
  if (p === "play" || p === "fast_forward" || p === "fast_reverse") return "playing";
  if (p === "pause") return "paused";
  if (p === "stop") return "stopped";
  return "idle";
}
export function supremeRepeatFromYamaha(r: YamahaNetUsbPlayInfo["repeat"]): "off" | "all" | "one" {
  return r === "all" || r === "one" ? r : "off";
}
export function supremeShuffleFromYamaha(s: YamahaNetUsbPlayInfo["shuffle"]): boolean {
  return s !== "off";
}

export interface YamahaMediaCache {
  power: boolean;
  volume: number;
  muted: boolean;
  input: string;
  soundProgram?: string;
  bass?: number;
  treble?: number;
  netusb: YamahaNetUsbPlayInfo | null;
}

export function buildYamahaMediaState(cache: YamahaMediaCache, volumeRange: AvrRange): CapabilityState {
  const advanced: Record<string, unknown> = {};
  if (cache.soundProgram !== undefined) advanced.soundProgram = cache.soundProgram;
  if (cache.bass !== undefined) advanced.bass = cache.bass;
  if (cache.treble !== undefined) advanced.treble = cache.treble;
  if (cache.netusb) advanced.transportAttribute = cache.netusb.attribute;
  const n = cache.netusb;
  return {
    kind: "media",
    playback: n ? playbackFromYamaha(n.playback) : "idle",
    volume: percentFromScale(cache.volume, volumeRange.min, volumeRange.max),
    muted: cache.muted,
    title: n?.track ?? null,
    artist: n?.artist ?? null,
    source: cache.input || null,
    artworkUrl: n?.artworkUrl ?? null,
    durationSec: n?.durationSec ?? null,
    positionSec: n?.positionSec ?? null,
    shuffle: n ? supremeShuffleFromYamaha(n.shuffle) : null,
    repeat: n ? supremeRepeatFromYamaha(n.repeat) : null,
    advanced: Object.keys(advanced).length > 0 ? advanced : null,
  };
}

// ── Events (UDP unicast push, §11) ────────────────────────────────────────────────

export interface YamahaZoneEvent {
  power?: boolean;
  input?: string;
  volume?: number;
  muted?: boolean;
  /** True when fields beyond power/input/volume/mute changed — the driver must pull a
   * fresh `getStatus` (and `netusb/getPlayInfo` if applicable) rather than trust only
   * the direct fields in this event (spec §11.3: hybrid direct-value + update-flag). */
  statusUpdated: boolean;
}

export interface YamahaEvent {
  zones: Partial<Record<YamahaZone, YamahaZoneEvent>>;
  netusbPlayInfoUpdated: boolean;
}

export function parseYamahaEvent(raw: string): YamahaEvent | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const zones: Partial<Record<YamahaZone, YamahaZoneEvent>> = {};
  for (const z of YAMAHA_ZONES) {
    const zj = json[z];
    if (!zj || typeof zj !== "object") continue;
    const zr = zj as Record<string, unknown>;
    zones[z] = {
      power: typeof zr.power === "string" ? zr.power === "on" : undefined,
      input: typeof zr.input === "string" ? zr.input : undefined,
      volume: typeof zr.volume === "number" ? zr.volume : undefined,
      muted: typeof zr.mute === "boolean" ? zr.mute : undefined,
      statusUpdated: zr.status_updated === true,
    };
  }
  const netusb = (json.netusb ?? {}) as Record<string, unknown>;
  return { zones, netusbPlayInfoUpdated: netusb.play_info_updated === true };
}

/** Extract `<manufacturer>`/`<friendlyName>` from a UPnP device description XML — just
 * enough to confirm "this MediaRenderer is actually a Yamaha" during discovery (spec
 * doesn't define this; it's the standard UPnP device-description document every
 * MediaRenderer publishes at its SSDP `LOCATION`). */
export function parseUpnpDescription(xml: string): { manufacturer: string | null; friendlyName: string | null } {
  const manufacturer = /<manufacturer>([^<]*)<\/manufacturer>/i.exec(xml)?.[1]?.trim() ?? null;
  const friendlyName = /<friendlyName>([^<]*)<\/friendlyName>/i.exec(xml)?.[1]?.trim() ?? null;
  return { manufacturer, friendlyName };
}
