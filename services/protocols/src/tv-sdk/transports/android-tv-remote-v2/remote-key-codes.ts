import type { TvRemoteKey } from "../../tv-types.js";

/**
 * (§5/§6 Phase 2 — verified key codes only) `RemoteKeyCode` values, cross-checked
 * against Android's own public `KeyEvent.KEYCODE_*` constants (these numbers are
 * standard, stable Android platform ABI, not androidtvremote2-specific — DPAD_UP=19,
 * BACK=4, HOME=3, etc.) AND confirmed present in remotemessage.proto's `RemoteKeyCode`
 * enum via direct inspection of the upstream Apache-2.0 reference
 * (github.com/tronikos/androidtvremote2). §35 "do not invent key codes" — every key
 * below is a verified value; `TvRemoteKey`s with no confirmed mapping are deliberately
 * absent from this table rather than guessed, and `keyCodeFor()` throws
 * `TvUnsupportedCommandError` for them (see android-tv-remote-v2-transport.ts).
 */
export const REMOTE_KEY_CODES: Partial<Record<TvRemoteKey, number>> = {
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  BACK: 4,
  HOME: 3,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  MUTE: 164, // KEYCODE_VOLUME_MUTE
  PLAY: 126, // KEYCODE_MEDIA_PLAY
  PAUSE: 127, // KEYCODE_MEDIA_PAUSE
  PLAY_PAUSE: 85, // KEYCODE_MEDIA_PLAY_PAUSE
  NEXT: 87, // KEYCODE_MEDIA_NEXT
  PREVIOUS: 88, // KEYCODE_MEDIA_PREVIOUS
  STOP: 86, // KEYCODE_MEDIA_STOP
  FAST_FORWARD: 90, // KEYCODE_MEDIA_FAST_FORWARD
  REWIND: 89, // KEYCODE_MEDIA_REWIND
  MENU: 82,
  INFO: 165,
  SETTINGS: 176,
  SEARCH: 84,
};

/** `RemoteDirection` enum (remotemessage.proto) — this transport always sends `SHORT`
 * (a normal tap) for every key; long-press semantics aren't exposed by
 * `TvTransport.sendKey()` today (§6 lists no long-press requirement) and adding
 * START_LONG/END_LONG support is a real, separable future addition, not something to
 * fabricate a policy for now. */
export const REMOTE_DIRECTION_SHORT = 3;
