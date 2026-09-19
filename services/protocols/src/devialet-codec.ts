import type { CapabilityState } from "@supreme/domain-model";
import type { DevialetPlayingState } from "./devialet-ip-control-client.js";

/**
 * Devialet → Supreme pure projection (§ D3/§ D8 final fix). This file is reduced to
 * the two genuinely reusable pure transformations: an incremental, per-device media
 * cache shape, and the function that turns a sufficiently-populated cache into a real
 * Supreme `media` `CapabilityState`. No HTTP/wire concerns belong here — those live
 * in `devialet-ip-control-client.ts`, and cache OWNERSHIP (the `Map`, patching,
 * publish-gating) lives in `devialet-driver.ts`, exactly mirroring
 * `AvrProtocolDriver`'s own `MediaCache`/`patchMedia()`/`buildMediaState()` split.
 *
 * § D8 final fix — R1's volume (system-level) and playback/metadata (group-level)
 * are two INDEPENDENT queries that can each succeed or fail on any given refresh
 * tick. The original D8 pass required both to succeed in the same tick before
 * publishing anything, which diverges from `AvrProtocolDriver`'s own incremental
 * `MediaCache` precedent (a single successful field patches a persistent cache, and
 * the FULL merged state is republished using last-known values for whatever wasn't
 * just touched). This cache shape is that same pattern, adapted for Devialet's two
 * distinct query halves instead of AVR's many small Telnet fields.
 *
 * Unlike AVR's own cache (which seeds a SYNTHETIC `{volume: 0, muted: false, source:
 * null}` default before any real data has ever arrived), this cache seeds NOTHING —
 * `volume`/`muted`/`playback` start `undefined` and stay that way until a real R1
 * response sets them at least once. `MediaState.volume`/`muted`/`playback` are all
 * non-optional, non-nullable schema fields (`packages/domain-model/src/
 * capabilities.ts`), so there is no honest way to represent "not yet known" within
 * the schema itself for these three — `hasPublishableDevialetMedia()` is the gate
 * that keeps the driver from ever constructing a `CapabilityState` before real values
 * for all three exist (§3 of the D8 final-fix brief: "never fabricate... do not
 * synthesize volume/playback/metadata/source/mute"). `title`/`artist`/`album`/
 * `source` ARE nullable in the schema, so `null` (never fabricated, just the
 * schema's own "unknown/absent" representation) is a safe, honest default for those.
 */
export interface DevialetMediaCacheEntry {
  /** From the system-level volume query. */
  volume?: number;
  /** From the group-level current-source query (`muteState`) — NOT the volume
   * response; R1 groups mute/unmute under `/groups/.../playback/mute`, not
   * `/systems/.../soundControl/volume`. */
  muted?: boolean;
  /** From the group-level current-source query (`playingState`), reported exactly
   * as R1 returns it — never corrected/inferred (see the doc's "pause on a source
   * that can't semantically pause instead mutes" behavior). */
  playback?: DevialetPlayingState;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  source?: string | null;
  availableOperations?: string[];
}

/** True once `cache` has real, previously-observed values for every non-optional,
 * non-nullable `MediaState` field (`volume`/`playback`/`muted`) — the ONLY three
 * fields with no honest "unknown" representation in the schema. Everything else
 * (`title`/`artist`/`album`/`source`) safely defaults to `null` at publish time. */
export function hasPublishableDevialetMedia(cache: DevialetMediaCacheEntry): boolean {
  return cache.volume !== undefined && cache.playback !== undefined && cache.muted !== undefined;
}

/**
 * Builds a Supreme `media` `CapabilityState` from a cache the caller has already
 * confirmed is `hasPublishableDevialetMedia()`. `artworkUrl` is supplied by the
 * CALLER (`devialet-driver.ts`), already resolved to the gateway's own artwork-proxy
 * URL (the same `artworkUrlFor(deviceId)` pattern `AvrProtocolDriver` uses) — never
 * the raw R1 `coverArtUrl` directly, and never resolved inside this pure function
 * (§6 of the D8 final-fix brief: artwork architecture unchanged).
 *
 * `availableOperations` has no dedicated `MediaState` field — reusing the existing,
 * already-generic `advanced` escape hatch (the same field AVR's bass/treble/
 * equalizer values ride in) is the correct, schema-compatible representation rather
 * than adding a new top-level domain-model field for one driver's data. `durationSec`/
 * `positionSec` are deliberately left unset — the R1 doc never documents the
 * `/playback/position` response shape (§ D3 report), so there is nothing safe to map.
 */
export function buildDevialetMediaState(cache: DevialetMediaCacheEntry, artworkUrl: string | null): CapabilityState {
  return {
    kind: "media",
    playback: cache.playback!,
    volume: cache.volume!,
    muted: cache.muted!,
    title: cache.title ?? null,
    artist: cache.artist ?? null,
    album: cache.album ?? null,
    source: cache.source ?? null,
    artworkUrl,
    advanced: { availableOperations: cache.availableOperations ?? [] },
  };
}

/**
 * § D9 — CISettings enrichment/reconciliation, precedence matrix.
 *
 * R1 (`devialet-ip-control-client.ts`) is the PRIMARY, modern protocol and is
 * authoritative for every field it documents. CISettings (`devialet-cisettings-
 * client.ts`) is a SECONDARY legacy/compatibility surface. This matrix is exhaustive
 * for the four fields the D9 brief asks about — nothing here is inferred beyond what
 * the two clients' own docs already establish (see their module docs):
 *
 * | Field   | R1 provides?                 | CISettings provides? | Winner                         |
 * |---------|-------------------------------|-----------------------|---------------------------------|
 * | Volume  | yes (system-level, `getVolume`) | yes (`volume` opcode) | R1 always. CISettings volume is NEVER merged into published state — see `getCiSettingsReconciliation()`, which surfaces both values for DIAGNOSTIC comparison only. |
 * | Mute    | yes (`muteState` on current source) | yes (`mutemode` opcode) | R1 always, for the SAME reason. CISettings `mutemode` is not even confirmed to be the same semantic concept (§ its own doc comment) — treated as a distinct, non-substitutable field, never coerced into R1's `muted`. |
 * | Source  | yes (group current-source `type`) | yes (`source` opcode, free-text token) | R1 always. CISettings' `source` uses its own legacy vocabulary (not R1's closed `DevialetSourceType` union) — even as a fallback it would require an unverified mapping this phase does not invent. |
 * | Power   | NOT DOCUMENTED — R1 has no power/on-off endpoint at all | yes (write-only `power`, read `powerstate`: standby/starting/running/stopping) | Neither "wins" — there is nothing for CISettings to conflict with. But `powerstate`'s 4-value semantics (transitional `starting`/`stopping`) don't collapse losslessly onto SupremeOS's boolean `onoff` capability, and `power`'s write side has no confirmed read-back. Per the D9 brief, this stays diagnostic-only (`getCiSettingsPowerState()`) — never published as `this.states`, never bound to the `onoff` capability. |
 *
 * The one general rule this table encodes: CISettings NEVER overwrites a field R1
 * already owns, regardless of whether CISettings' own value agrees or conflicts, and
 * regardless of whether R1's read fails on a given tick (a failed R1 read means "no
 * new data this tick," not "fall back to CISettings" — see `refreshMediaState()`'s
 * own incremental-cache doc). CISettings' role is strictly enrichment/diagnostics for
 * fields R1 does not cover at all (or comparison-only reporting for fields it does).
 */
export interface DevialetCiSettingsReconciliation {
  field: "volume" | "muted" | "source";
  /** R1's own last-known-published value for this field (`null` if R1 has never
   * published anything for this device yet — see `hasPublishableDevialetMedia()`). */
  r1Value: number | boolean | string | null;
  /** CISettings' own value for this field, or `null` if the CISettings read for it
   * failed (transport/HTTP/malformed) — a failure NEVER blocks reporting the other
   * fields (§ D9-G failure isolation), it just reports `null` for that one row. */
  ciSettingsValue: number | boolean | string | null;
  /** `true` only when both sides have a real (non-null) value AND they match. A
   * missing CISettings value is neither "agree" nor "conflict" — it's simply
   * unavailable, so `agree` is `false` but callers should check `ciSettingsValue`
   * before treating this as a real conflict. */
  agree: boolean;
}

/**
 * Pure comparison — takes R1's already-published (or cached) values and CISettings'
 * independently-fetched values and reports where they agree/disagree. Never mutates
 * anything, never decides what SupremeOS should publish (R1 always wins per the
 * matrix above) — this exists purely so a diagnostics caller (`devialet-driver.ts`'s
 * `getCiSettingsReconciliation()`) can surface the comparison without duplicating
 * this logic inline.
 */
export function reconcileDevialetCiSettings(
  r1: { volume: number | null; muted: boolean | null; source: string | null },
  ciSettings: { volume: number | null; muted: boolean | null; source: string | null },
): DevialetCiSettingsReconciliation[] {
  const rows: DevialetCiSettingsReconciliation[] = [];
  for (const field of ["volume", "muted", "source"] as const) {
    const r1Value = r1[field];
    const ciSettingsValue = ciSettings[field];
    rows.push({
      field,
      r1Value,
      ciSettingsValue,
      agree: r1Value !== null && ciSettingsValue !== null && r1Value === ciSettingsValue,
    });
  }
  return rows;
}
