import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";
import type { AudioCapabilityConfig } from "./avr-capabilities.js";

/**
 * HEOS CLI codec (§3) — Denon/Marantz HEOS streaming module protocol. Telnet port 1255,
 * `heos://group/command?k=v&...` request URIs (CRLF-delimited), JSON responses whose
 * `heos.message` field is itself an `&`-delimited `k=v` string (CRLF-delimited too).
 * Verified against the attached HEOS CLI Protocol Specification v1.17 — every command,
 * event, and enum below appears in that document; nothing here is guessed.
 *
 * One real, protocol-verified fact carried forward honestly: HEOS has NO power command
 * (verified: none exists anywhere in the spec) — HEOS is a streaming module, not an
 * amplifier, and is always reachable once online. This driver therefore never exposes an
 * `onoff` capability; only `media`. Likewise there is no wire-level seek/position-set
 * command — `positionSec` is reported (via `player_now_playing_progress`) but not
 * settable here.
 */

const PARAM_PCT = /%/g;
const PARAM_AMP = /&/g;
const PARAM_EQ = /=/g;

/** Encode one command param per the spec's escaping rule (order matters: '%' first, so
 * the '%' introduced by escaping '&'/'=' is never itself re-escaped). */
export function encodeHeosParam(value: string | number): string {
  return String(value).replace(PARAM_PCT, "%25").replace(PARAM_AMP, "%26").replace(PARAM_EQ, "%3D");
}

function decodeHeosValue(value: string): string {
  return value.replace(/%3D/gi, "=").replace(/%26/gi, "&").replace(/%25/gi, "%");
}

/** Build a full `heos://group/command?...` request line (without the CRLF terminator). */
export function buildHeosCommand(group: string, command: string, params: Record<string, string | number> = {}): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeHeosParam(v)}`)
    .join("&");
  return qs ? `heos://${group}/${command}?${qs}` : `heos://${group}/${command}`;
}

/** Parse a response/event `message` string ("pid=1&state=play") into a flat attribute map. */
export function parseHeosAttrs(message: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!message) return out;
  for (const pair of message.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    out[pair.slice(0, eq).trim()] = decodeHeosValue(pair.slice(eq + 1));
  }
  return out;
}

export function heosRepeatFromSupreme(repeat: "off" | "all" | "one"): string {
  if (repeat === "all") return "on_all";
  if (repeat === "one") return "on_one";
  return "off";
}
export function supremeRepeatFromHeos(repeat: string | undefined): "off" | "all" | "one" {
  if (repeat === "on_all") return "all";
  if (repeat === "on_one") return "one";
  return "off";
}

/** The other play-mode field, needed because `set_play_mode` requires BOTH repeat and
 * shuffle in the same request (spec §4.2.9) — commanding one must not silently reset
 * the other, so the driver passes the current cached value through here. */
export interface HeosPlayModeContext {
  repeat?: "off" | "all" | "one";
  shuffle?: boolean;
}

export interface HeosRequest {
  group: string;
  command: string;
  params: Record<string, string | number>;
}

/** Translate a Supreme `media` command into a HEOS CLI request (null = unsupported on
 * this protocol). `pid` addresses the target player on the shared connection. */
export function commandToHeos(command: CapabilityCommand, pid: string, ctx: HeosPlayModeContext = {}): HeosRequest | null {
  if (command.capability !== "media") return null;
  switch (command.action) {
    case "play":
      return { group: "player", command: "set_play_state", params: { pid, state: "play" } };
    case "pause":
      return { group: "player", command: "set_play_state", params: { pid, state: "pause" } };
    case "stop":
      return { group: "player", command: "set_play_state", params: { pid, state: "stop" } };
    case "next":
      return { group: "player", command: "play_next", params: { pid } };
    case "previous":
      return { group: "player", command: "play_previous", params: { pid } };
    case "volume":
      // HEOS volume is natively 0-100 — no scale conversion needed (unlike Denon's MV).
      return typeof command.volume === "number"
        ? { group: "player", command: "set_volume", params: { pid, level: Math.round(command.volume) } }
        : null;
    case "mute":
      return { group: "player", command: "set_mute", params: { pid, state: "on" } };
    case "unmute":
      return { group: "player", command: "set_mute", params: { pid, state: "off" } };
    case "source":
      return typeof command.source === "string"
        ? { group: "browse", command: "play_input", params: { pid, input: command.source } }
        : null;
    case "shuffle":
      if (typeof command.shuffle !== "boolean") return null;
      return {
        group: "player",
        command: "set_play_mode",
        params: { pid, repeat: heosRepeatFromSupreme(ctx.repeat ?? "off"), shuffle: command.shuffle ? "on" : "off" },
      };
    case "repeat":
      if (!command.repeat) return null;
      return {
        group: "player",
        command: "set_play_mode",
        params: { pid, repeat: heosRepeatFromSupreme(command.repeat), shuffle: ctx.shuffle ? "on" : "off" },
      };
    case "advanced": {
      const adv = command.advanced;
      if (!adv) return null;
      if (typeof adv.preset === "number") return { group: "browse", command: "play_preset", params: { pid, preset: adv.preset } };
      if (typeof adv.quickSelect === "number") return { group: "player", command: "play_quickselect", params: { pid, id: adv.quickSelect } };
      return null;
    }
    case "seek":
      return null; // no wire-level seek/position-set command exists in HEOS CLI (verified, v1.17)
    default:
      return null;
  }
}

export interface HeosPlayerInfo {
  pid: string;
  name: string;
  model?: string;
  version?: string;
}

export interface HeosNowPlaying {
  type: string;
  song: string | null;
  station: string | null;
  album: string | null;
  artist: string | null;
  imageUrl: string | null;
  /** The spec's `sid` (source id) field — identifies which music service is actually
   * playing (Pandora/Spotify/Tidal/…), distinct from `type`'s generic song/station split.
   * Absent on responses that don't include it (verified: not every payload carries one). */
  sourceId: number | null;
}

export type HeosUpdate =
  | { kind: "players"; players: HeosPlayerInfo[] }
  | { kind: "playState"; pid: string; state: "play" | "pause" | "stop" }
  | { kind: "volume"; pid: string; level: number; muted?: boolean }
  | { kind: "mute"; pid: string; muted: boolean }
  | { kind: "playMode"; pid: string; repeat: "off" | "all" | "one"; shuffle: boolean }
  | { kind: "repeatMode"; pid: string; repeat: "off" | "all" | "one" }
  | { kind: "shuffleMode"; pid: string; shuffle: boolean }
  | { kind: "nowPlaying"; pid: string; media: HeosNowPlaying }
  | { kind: "nowPlayingChanged"; pid: string }
  | { kind: "progress"; pid: string; positionSec: number; durationSec: number }
  | { kind: "source"; pid: string; source: string }
  | { kind: "queue"; pid: string; sequence: string | null; items: HeosQueueItem[] }
  | { kind: "playersChanged" }
  | { kind: "error"; command: string; text: string };

export interface HeosQueueItem {
  qid: string;
  song: string | null;
  album: string | null;
  artist: string | null;
  imageUrl: string | null;
}

/** Parse one full JSON response/event line (already split on the CRLF delimiter) into a
 * structured update (null = unrecognized/no-state-change response, e.g. a bare command
 * ack for `play_input`/`play_preset`/`play_quickselect`). */
export function parseHeosMessage(raw: string): HeosUpdate | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let msg: { heos?: { command?: string; result?: string; message?: string }; payload?: unknown };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const heos = msg.heos;
  if (!heos || typeof heos.command !== "string") return null;
  const command = heos.command.trim();
  const attrs = parseHeosAttrs(heos.message);

  if (heos.result === "fail") return { kind: "error", command, text: attrs.text ?? heos.message ?? "unknown error" };

  switch (command) {
    case "player/get_players": {
      const payload = Array.isArray(msg.payload) ? (msg.payload as Record<string, unknown>[]) : [];
      return {
        kind: "players",
        players: payload.map((p) => ({
          pid: String(p.pid),
          name: String(p.name ?? ""),
          model: typeof p.model === "string" ? p.model : undefined,
          version: typeof p.version === "string" ? p.version : undefined,
        })),
      };
    }
    case "player/get_play_state":
    case "player/set_play_state":
    case "event/player_state_changed":
      if (!attrs.pid || !attrs.state) return null;
      return { kind: "playState", pid: attrs.pid, state: attrs.state as "play" | "pause" | "stop" };
    case "player/get_volume":
    case "player/set_volume":
      if (!attrs.pid || attrs.level === undefined) return null;
      return { kind: "volume", pid: attrs.pid, level: Number(attrs.level) };
    case "event/player_volume_changed":
      if (!attrs.pid || attrs.level === undefined) return null;
      return { kind: "volume", pid: attrs.pid, level: Number(attrs.level), muted: attrs.mute === "on" };
    case "player/get_mute":
    case "player/set_mute":
    case "player/toggle_mute":
      if (!attrs.pid || attrs.state === undefined) return null;
      return { kind: "mute", pid: attrs.pid, muted: attrs.state === "on" };
    case "player/get_play_mode":
    case "player/set_play_mode":
      if (!attrs.pid) return null;
      return { kind: "playMode", pid: attrs.pid, repeat: supremeRepeatFromHeos(attrs.repeat), shuffle: attrs.shuffle === "on" };
    case "event/repeat_mode_changed":
      if (!attrs.pid) return null;
      return { kind: "repeatMode", pid: attrs.pid, repeat: supremeRepeatFromHeos(attrs.repeat) };
    case "event/shuffle_mode_changed":
      if (!attrs.pid) return null;
      return { kind: "shuffleMode", pid: attrs.pid, shuffle: attrs.shuffle === "on" };
    case "player/get_now_playing_media": {
      if (!attrs.pid) return null;
      const p = (msg.payload ?? {}) as Record<string, unknown>;
      return {
        kind: "nowPlaying",
        pid: attrs.pid,
        media: {
          type: typeof p.type === "string" ? p.type : "song",
          song: typeof p.song === "string" ? p.song : null,
          station: typeof p.station === "string" ? p.station : null,
          album: typeof p.album === "string" ? p.album : null,
          artist: typeof p.artist === "string" ? p.artist : null,
          imageUrl: typeof p.image_url === "string" && p.image_url ? p.image_url : null,
          sourceId: typeof p.sid === "number" ? p.sid : typeof p.sid === "string" && p.sid !== "" ? Number(p.sid) : null,
        },
      };
    }
    case "event/player_now_playing_changed":
      return attrs.pid ? { kind: "nowPlayingChanged", pid: attrs.pid } : null;
    case "event/player_now_playing_progress":
      if (!attrs.pid || attrs.cur_pos === undefined || attrs.duration === undefined) return null;
      return { kind: "progress", pid: attrs.pid, positionSec: Number(attrs.cur_pos) / 1000, durationSec: Number(attrs.duration) / 1000 };
    case "player/get_queue": {
      if (!attrs.pid) return null;
      const payload = Array.isArray(msg.payload) ? (msg.payload as Record<string, unknown>[]) : [];
      return {
        kind: "queue",
        pid: attrs.pid,
        sequence: attrs.sequence ?? null,
        items: payload.map((p) => ({
          qid: String(p.qid ?? ""),
          song: typeof p.song === "string" ? p.song : null,
          album: typeof p.album === "string" ? p.album : null,
          artist: typeof p.artist === "string" ? p.artist : null,
          imageUrl: typeof p.image_url === "string" && p.image_url ? p.image_url : null,
        })),
      };
    }
    case "browse/play_input":
      // Also fires a Now Playing Changed event for aux-in streams (spec §4.4.9); that
      // event triggers our own get_now_playing_media re-query separately.
      return attrs.pid && attrs.input ? { kind: "source", pid: attrs.pid, source: attrs.input } : null;
    case "event/players_changed":
      return { kind: "playersChanged" };
    default:
      return null;
  }
}

export function playbackFromHeosState(state: "play" | "pause" | "stop"): "playing" | "paused" | "stopped" | "idle" {
  if (state === "play") return "playing";
  if (state === "pause") return "paused";
  return "stopped";
}

export interface HeosMediaCache {
  playback: "playing" | "paused" | "stopped" | "idle";
  volume: number;
  muted: boolean;
  source: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  artworkUrl: string | null;
  durationSec: number | null;
  positionSec: number | null;
  shuffle: boolean | null;
  repeat: "off" | "all" | "one" | null;
}

export function buildHeosMediaState(cache: HeosMediaCache): CapabilityState {
  return {
    kind: "media",
    playback: cache.playback,
    volume: cache.volume,
    muted: cache.muted,
    title: cache.title,
    artist: cache.artist,
    album: cache.album,
    source: cache.source,
    artworkUrl: cache.artworkUrl,
    durationSec: cache.durationSec,
    positionSec: cache.positionSec,
    shuffle: cache.shuffle,
    repeat: cache.repeat,
    advanced: null,
  };
}

/** Fixed `browse/play_input` input enum (spec §4.4.13) — protocol-level, not per-unit,
 * so every HEOS player advertises the same list (validity of any given entry still
 * depends on what physical inputs that model actually has, same caveat the spec itself
 * states). */
export const HEOS_INPUTS = [
  "aux_in_1", "aux_in_2", "aux_in_3", "aux_in_4", "aux_single", "aux1", "aux2", "aux3", "aux4", "aux5", "aux6", "aux7", "aux_8k",
  "line_in_1", "line_in_2", "line_in_3", "line_in_4", "coax_in_1", "coax_in_2", "optical_in_1", "optical_in_2", "optical_in_3",
  "hdmi_in_1", "hdmi_in_2", "hdmi_in_3", "hdmi_in_4", "hdmi_arc_1", "cable_sat", "dvd", "bluray", "game", "game2", "mediaplayer",
  "cd", "tuner", "hdradio", "tvaudio", "phono", "usbdac", "analog_in_1", "analog_in_2", "recorder_in_1", "tv",
] as const;

/** Best-guess icon category per input (§ `AvrInput.type` — a display hint only; the
 * spec's `browse/play_input` enum has no notion of physical-connector type). */
function heosInputType(id: (typeof HEOS_INPUTS)[number]): string | undefined {
  if (id.startsWith("hdmi")) return "hdmi";
  if (id.startsWith("optical") || id.startsWith("coax")) return "optical";
  if (id.startsWith("aux") || id.startsWith("line_in") || id.startsWith("analog_in") || id === "recorder_in_1" || id === "phono") return "analog";
  if (id === "tuner" || id === "hdradio") return "tuner";
  if (id === "usbdac") return "usb";
  if (["cable_sat", "dvd", "bluray", "game", "game2", "mediaplayer", "cd", "tvaudio", "tv"].includes(id)) return "hdmi";
  return undefined;
}

/** The AudioCapabilityConfig for a HEOS player — `device_reported` because the input
 * enum and transport surface are fixed facts of the published protocol (same for every
 * unit), not something an installer manually declares, even though nothing is queried
 * live per-device the way Yamaha's `getFeatures` is. */
export function heosCapabilityConfig(): AudioCapabilityConfig {
  return {
    source: "device_reported",
    inputs: HEOS_INPUTS.map((id) => ({ id: `inputs/${id}`, label: id.replace(/_/g, " "), type: heosInputType(id) })),
    transport: { play: true, pause: true, stop: true, next: true, previous: true, seek: false, shuffle: true, repeat: true },
  };
}
