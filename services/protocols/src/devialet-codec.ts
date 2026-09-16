import type { CapabilityState } from "@supreme/domain-model";
import type { DevialetCurrentSource } from "./devialet-ip-control-client.js";

/**
 * Devialet → Supreme pure projection (§ D3). The old wire-request-building functions
 * that used to live here (`commandToDevialet`, `stateFromDevialet`,
 * `DEVIALET_STATE_PATHS`) are REMOVED — they targeted a factually incorrect endpoint
 * shape (volume under `/groups/.../soundControl/volume`; the real R1 doc places it
 * under `/systems/{systemId}/sources/current/soundControl/volume` — volume is
 * SYSTEM-level, never group-level). All real request-building now lives in
 * `devialet-ip-control-client.ts`, verified directly against the R1 documentation.
 * This file is reduced to the one genuinely reusable pure transformation: turning a
 * real, typed R1 response into a Supreme `media` `CapabilityState`. No HTTP/wire
 * concerns belong here.
 */

/**
 * Projects a real Devialet current-source response + system volume into a Supreme
 * `media` `CapabilityState`. `source.type` is used verbatim as the Supreme `source`
 * field — Devialet's own source-type vocabulary ("spotifyconnect", "airplay2", …) is
 * preserved rather than translated, since Supreme's `MediaState.source` is a free-form
 * label field, not a closed enum. `playingState`/`muteState` are reported EXACTLY as
 * the device reports them, never corrected or inferred — this matters most for the
 * documented "pause on a source that can't semantically pause instead mutes"
 * behavior (see `DevialetIpControlClient.pause()`'s doc): this function must not paper
 * over that by assuming a pause command implies `playback: "paused"`.
 */
export function mediaStateFromDevialet(current: DevialetCurrentSource, volume: number): CapabilityState {
  return {
    kind: "media",
    playback: current.playingState,
    volume,
    muted: current.muteState === "muted",
    title: current.metadata?.title ?? null,
    artist: current.metadata?.artist ?? null,
    album: current.metadata?.album ?? null,
    source: current.source?.type ?? null,
    // § D8 owns real artwork integration. `current.metadata?.coverArtUrl` is real
    // protocol data (already typed and available on the R1 client's response) but is
    // deliberately not consumed here yet — never fabricated as `null` meaning
    // "unavailable" vs. "not wired up yet" would be indistinguishable to a caller
    // either way, so leaving it `null` here is honest, not a placeholder lie.
    artworkUrl: null,
  };
}
