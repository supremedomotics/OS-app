/**
 * SupremeOS Universal AV SDK — Network Source Resolver (§ Network Source Architecture pass).
 *
 * Investigation summary (evidence, not assumption — see the production report for full
 * citations): Denon/Marantz's classic Telnet control protocol and Yamaha's MusicCast YXC
 * protocol are NOT ambiguous about network sources — Telnet's `SI` table already has
 * separate tokens for Internet Radio (`IRADIO`), Media Server (`SERVER`), USB (`USB/IPOD`),
 * etc. (see `avr-codec.ts`), and MusicCast's `/system/getFeatures` already reports the
 * specific active service as its own input id ("spotify", "airplay", "tidal", "bluetooth",
 * …, see `yamaha-codec.ts`). Neither protocol needs a runtime resolver — a static per-token
 * label map is the honest, complete answer for both, and that's what each codec already has.
 *
 * HEOS CLI is the one genuinely ambiguous case: every streaming service plays through the
 * SAME `player/get_now_playing_media` response shape, distinguished only by a numeric
 * `sid` (source id) field the spec defines (confirmed against the HEOS CLI Protocol
 * Specification v1.17 — the same spec `heos-codec.ts` already cites — and cross-verified
 * against `pyheos` (github.com/andrewsayre/pyheos), the actively-maintained open-source HEOS
 * client library Home Assistant's own HEOS integration is built on, whose `MUSIC_SOURCE_*`
 * constants mirror the spec's sid table exactly). This module resolves that one real
 * ambiguity; nothing here is guessed or fabricated for a sid this codebase couldn't verify.
 *
 * AirPlay (§ Part 4 investigation): confirmed via Denon's own published support
 * documentation ("Source input will be switched to 'HEOS Music' when AirPlay playback is
 * started") that AirPlay has NO dedicated `SI` token and NO HEOS `sid` — it rides the same
 * NET/"HEOS Music" input as every other HEOS-routed service, and the receiver's own front
 * panel displays it exactly that way. There is nothing to resolve; showing "HEOS Music"
 * during an AirPlay session is protocol-correct, not a limitation. Bluetooth, Chromecast,
 * and Roon Ready have no `sid` entry in the verified table and no `SI` token in the verified
 * Denon parameter table either — unsupported, not silently gated as something else.
 */

/** Verified HEOS CLI `sid` (source id) → real service name. Every entry here is a spec-
 * verified numeric id (cross-checked against `pyheos`'s `MUSIC_SOURCE_*` constants); no
 * entry is a guess, and no id without a name that's actually a music *service* (aggregator
 * source id `0` — "Connect" — is intentionally omitted here since it does not correspond
 * to any single displayable service name). */
export const HEOS_SOURCE_LABELS: Record<number, string> = {
  1: "Pandora",
  2: "Rhapsody",
  3: "TuneIn",
  4: "Spotify",
  5: "Deezer",
  6: "Napster",
  7: "iHeartRadio",
  8: "SiriusXM",
  9: "SoundCloud",
  10: "Tidal",
  12: "Rdio",
  13: "Amazon Music",
  15: "Moodmix",
  16: "Juke",
  18: "QQ Music",
  1024: "Local Music",
  1025: "HEOS Playlists",
  1026: "HEOS History",
  1027: "Aux Input",
  1028: "HEOS Favorites",
};

export interface HeosNowPlayingSourceInput {
  /** The spec's `sid` field, when the response included one. */
  sourceId?: number | null;
  /** `get_now_playing_media`'s `type` field ("song" | "station"). */
  type?: string | null;
  /** Populated for `type: "station"` — the actual station name (e.g. "Jazz FM"), always
   * more specific than a generic "TuneIn" service label, so it wins when present. */
  station?: string | null;
}

/** Resolve the best honest display name for what a HEOS player is currently routed
 * through. Returns `null` — never a guess — when nothing verified applies, so the caller
 * can leave the device's last-known explicit input selection (e.g. an AUX pick) alone
 * instead of overwriting it with nothing. Station name always wins over a generic service
 * label (a real station name is strictly more useful than "TuneIn"); otherwise a mapped
 * `sid` wins (this is what makes Spotify/Tidal/Amazon Music/etc. show their real name
 * instead of disappearing, § Part 1/2 root cause). */
export function resolveHeosSourceLabel(input: HeosNowPlayingSourceInput): string | null {
  if (input.type === "station" && input.station) return input.station;
  if (typeof input.sourceId === "number") {
    const label = HEOS_SOURCE_LABELS[input.sourceId];
    if (label) return label;
  }
  return null;
}
