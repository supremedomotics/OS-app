import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";

/**
 * WiiM / LinkPlay HTTP-API codec (§3). WiiM streamers (and the wider LinkPlay
 * ecosystem) expose an openly-documented HTTP API at `http://<host>/httpapi.asp?command=…`:
 * `getPlayerStatus` returns JSON (status/vol/mute + hex-encoded Title/Artist), and
 * `setPlayerCmd:*` drives transport/volume. Maps to the Supreme `media` capability.
 */

/** LinkPlay hex-encodes track metadata (UTF-8 → hex). Decode defensively. */
export function decodeHex(s: string | undefined): string | null {
  if (!s) return null;
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    try {
      const out = Buffer.from(s, "hex").toString("utf8");
      return out.length > 0 ? out : null;
    } catch {
      return s;
    }
  }
  return s;
}

/** The httpapi command string for a Supreme media command (null = unsupported). */
export function commandToLinkPlay(command: CapabilityCommand): string | null {
  if (command.capability !== "media") return null;
  switch (command.action) {
    case "play":
      return "setPlayerCmd:play";
    case "pause":
      return "setPlayerCmd:pause";
    case "stop":
      return "setPlayerCmd:stop";
    case "next":
      return "setPlayerCmd:next";
    case "previous":
      return "setPlayerCmd:prev";
    case "volume":
      return typeof command.volume === "number"
        ? `setPlayerCmd:vol:${Math.max(0, Math.min(100, Math.round(command.volume)))}`
        : null;
    case "mute":
      return "setPlayerCmd:mute:1";
    case "unmute":
      return "setPlayerCmd:mute:0";
    default:
      return null;
  }
}

type Playback = "playing" | "paused" | "stopped" | "idle";
function playback(status: string): Playback {
  switch (status) {
    case "play":
      return "playing";
    case "pause":
      return "paused";
    case "stop":
      return "stopped";
    default:
      return "idle";
  }
}

/** Parse a LinkPlay getPlayerStatus payload into a Supreme MediaState. */
export function stateFromLinkPlay(json: Record<string, unknown>): CapabilityState {
  const vol = Number(json.vol ?? 0);
  const mute = json.mute === 1 || json.mute === "1";
  return {
    kind: "media",
    playback: playback(String(json.status ?? "")),
    volume: Math.max(0, Math.min(100, vol)),
    muted: mute,
    title: decodeHex(json.Title as string | undefined),
    artist: decodeHex(json.Artist as string | undefined),
    source: typeof json.mode === "string" ? json.mode : null,
    artworkUrl: null,
  };
}
