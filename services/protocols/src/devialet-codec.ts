import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";

/**
 * Devialet (Phantom) local IP-control codec (§3). Devialet speakers expose a local
 * HTTP API under `/ipcontrol/v1/...` (community-documented). This maps the Supreme
 * `media` capability to that API's endpoints and parses its volume/playing state back.
 *
 * Endpoints are returned as {method,path,body} so the driver stays a thin HTTP client.
 */
export interface DevialetCall {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

const SRC = "/ipcontrol/v1/groups/current/sources/current";

/** Map a Supreme media command to a Devialet HTTP call (null = unsupported). */
export function commandToDevialet(command: CapabilityCommand): DevialetCall | null {
  if (command.capability !== "media") return null;
  switch (command.action) {
    case "play":
      return { method: "POST", path: `${SRC}/playback/play` };
    case "pause":
      return { method: "POST", path: `${SRC}/playback/pause` };
    case "stop":
      return { method: "POST", path: `${SRC}/playback/pause` };
    case "next":
      return { method: "POST", path: `${SRC}/playback/next` };
    case "previous":
      return { method: "POST", path: `${SRC}/playback/previous` };
    case "volume":
      return typeof command.volume === "number"
        ? { method: "POST", path: `${SRC}/soundControl/volume`, body: { volume: clamp(command.volume) } }
        : null;
    case "mute":
      return { method: "POST", path: `${SRC}/soundControl/mute` };
    case "unmute":
      return { method: "POST", path: `${SRC}/soundControl/unmute` };
    default:
      return null;
  }
}

/** The GET path for current volume + playback state. */
export const DEVIALET_STATE_PATHS = {
  volume: `${SRC}/soundControl/volume`,
  playback: `${SRC}/playback`,
};

/** Build a Supreme MediaState from the Devialet volume + playback payloads. */
export function stateFromDevialet(
  volumeJson: Record<string, unknown>,
  playbackJson: Record<string, unknown>,
): CapabilityState {
  const playState = String(playbackJson.state ?? playbackJson.playingState ?? "");
  const playback =
    playState === "playing" ? "playing" : playState === "paused" ? "paused" : playState === "stopped" ? "stopped" : "idle";
  return {
    kind: "media",
    playback,
    volume: clamp(Number(volumeJson.volume ?? 0)),
    muted: volumeJson.mute === true || volumeJson.muteState === "muted",
    title: typeof playbackJson.title === "string" ? playbackJson.title : null,
    artist: typeof playbackJson.artist === "string" ? playbackJson.artist : null,
    source: typeof playbackJson.source === "string" ? playbackJson.source : null,
    artworkUrl: null,
  };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
