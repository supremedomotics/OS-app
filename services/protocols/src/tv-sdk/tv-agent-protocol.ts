/**
 * (§2 Phase 3 — TV Agent wire protocol) Versioned envelope + message schema for the
 * SupremeOS ↔ SupremeOS TV Agent channel. This is a DIFFERENT wire protocol from
 * Android TV Remote v2 (android-tv-remote-v2-transport.ts) — the Agent is an optional,
 * independent feedback channel (MediaSession/foreground-app observation), never a
 * replacement for or a dependency of Remote v2 control. Nothing in this file is
 * upstream-sourced (there is no reference implementation to verify against, unlike
 * Remote v2); it's SupremeOS's own protocol, so "verified" here means "internally
 * consistent and schema-enforced," not "matches a third party."
 *
 * Hand-rolled validation (matching this package's existing tv-sdk convention — see
 * tv-types.ts's plain interfaces — none of the sibling files here use zod) rather than
 * a new dependency: `@supreme/protocols` doesn't declare zod today, and this message set
 * is small and stable enough that a manual validator is the "already covered by a few
 * lines" rung, not a shortcut around correctness — every message shape has a matching
 * negative test in tv-agent-protocol.test.ts.
 *
 * (§5 Phase 3A — version negotiation) `protocolVersion` is the MAJOR version: a
 * breaking envelope/message-shape change. `protocolMinor` (optional, defaults to 0) is
 * an ADDITIVE-ONLY change — a new optional field or a new `messageType` a future minor
 * version might add. Compatibility rule, deliberately simple and testable:
 *   - major mismatch  → REJECT (never coerced/ignored) — an older SupremeOS talking to
 *     a newer, incompatible Agent (or vice versa) must fail safely, not guess.
 *   - minor mismatch  → ACCEPT — a lower minor from an older Agent is missing nothing
 *     this build requires (every field this build reads was already required at minor
 *     0); a higher minor from a newer Agent may carry additional fields this build
 *     doesn't know about, which are simply not read (forward-compatible by
 *     construction, since payload validation only checks fields THIS build cares
 *     about — it never rejects a payload for having EXTRA fields).
 *   - unknown `messageType` → REJECT — the Agent protocol is entirely SupremeOS's own
 *     (no third-party firmware to be lenient for, unlike RemoteMessage's envelope arms),
 *     so an unrecognized type is always a real error, never silently ignored.
 * Required vs. optional fields are exactly what each payload interface below declares
 * (TypeScript's own `?`/non-`?` split doubles as the documented contract) — nothing is
 * "sometimes required based on version."
 */
export const AGENT_PROTOCOL_VERSION = 1;
export const AGENT_PROTOCOL_MINOR = 0;

/** §6 Phase 3A — defensive size limits, same discipline as Remote v2's framing
 * (framed-socket.ts's MAX_FRAME_SIZE). Applied BEFORE expensive processing (JSON
 * parsing, array iteration) wherever practical, so a malicious/misbehaving Agent can
 * never cause unbounded memory allocation. Numbers are deliberately generous for real
 * metadata and hostile toward abuse — nothing in §5's official Android APIs produces
 * a title, artist, or package name anywhere near these lengths. */
export const AGENT_LIMITS = {
  /** One wire message, serialized, in bytes. Well above any legitimate metadata
   * snapshot; anything larger is presumed hostile/corrupt, not "a device with a lot of
   * apps" (see MAX_APP_INVENTORY_ENTRIES, which bounds that case explicitly instead). */
  maxMessageBytes: 64 * 1024,
  maxAppInventoryEntries: 2000,
  maxPackageNameLength: 255,
  maxApplicationNameLength: 255,
  /** title/artist/album/subtitle/displayTitle/queueTitle/genre. */
  maxMetadataFieldLength: 500,
  /** mediaUri/artworkUri — §13 "prefer a URI/reference model," never inline binary. */
  maxUriLength: 2048,
  maxMediaIdLength: 255,
  maxSupportedActionsEntries: 64,
  maxCustomActionsEntries: 64,
} as const;

/** True when `theirMajor` is a version this build can safely process at all — the only
 * question major-version compatibility answers; minor is never checked here because a
 * minor difference is accepted unconditionally per this file's doc comment above. */
export function isCompatibleProtocolMajor(theirMajor: number): boolean {
  return theirMajor === AGENT_PROTOCOL_VERSION;
}

export type MediaConfidence = "exact" | "metadata" | "app_only" | "unknown";
export type ForegroundSource = "agent_accessibility" | "platform_foreground_api" | "adb" | "last_known";
export type AgentOsName = "android_tv" | "google_tv" | "fire_os" | "vega_os" | "unknown";
export type AgentFeedbackMechanism = "media_session" | "foreground_accessibility" | "app_inventory";

export interface AgentDeviceInfoPayload {
  manufacturer: string | null;
  model: string | null;
  osName: AgentOsName;
  apiLevel: number | null;
  agentVersion: string;
  supportedFeedbackMechanisms: AgentFeedbackMechanism[];
}

export interface AgentAppInventoryEntry {
  packageName: string;
  applicationName: string | null;
  version: string | null;
  launchable: boolean;
  installed: boolean;
}

export interface AgentForegroundAppPayload {
  packageName: string | null;
  applicationName: string | null;
  source: ForegroundSource;
  confidence: MediaConfidence;
}

/** Mirrors `android.media.session.PlaybackState`'s reported fields — only what §5's
 * source APIs actually expose, nothing inferred. */
export interface AgentMediaSessionPayload {
  packageName: string;
  applicationName: string | null;
  playbackState: "playing" | "paused" | "stopped" | "idle" | "buffering" | "error";
  playbackPositionMs: number | null;
  durationMs: number | null;
  playbackSpeed: number | null;
  title: string | null;
  displayTitle: string | null;
  subtitle: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  mediaId: string | null;
  mediaUri: string | null;
  artworkUri: string | null;
  queueTitle: string | null;
  supportedActions: string[];
  customActions: string[];
  shuffle: boolean | null;
  repeat: "off" | "all" | "one" | null;
  confidence: MediaConfidence;
  /** MediaSession's own monotonic sequence, when the platform exposes one — lets
   * TvStateCache do real revision-based ordering instead of falling back to arrival
   * order (see tv-state-cache.ts's doc comment). */
  sessionRevision: number | null;
}

interface EnvelopeFields {
  protocolVersion: number;
  /** §5 — additive-only minor version; absent/undefined is treated as 0 (an Agent
   * built before this field existed). Never required, never gates acceptance. */
  protocolMinor?: number;
  agentId: string;
  deviceId: string;
  messageId: string;
  timestamp: string;
  /** §2/§4 — present on every message once a session is authenticated (`hello`/`pair`
   * happen before one exists, so it's optional only on those two message types — see
   * REQUIRES_SESSION_ID below for the exact rule enforced by parseAgentMessage). */
  sessionId?: string;
  /** §4 replay/duplicate protection — a per-session strictly-increasing counter the
   * Agent must never reuse or reorder. `tv-agent-session-registry.ts` is what actually
   * enforces monotonicity across messages (this file only checks the field's shape);
   * required together with `sessionId` for the same reason. */
  sequenceNumber?: number;
}

/** §2/§9 Phase 3A — every message's snapshot/delta/notification/request/response
 * semantics, documented and machine-checkable rather than left implicit:
 *   - "request"/"response": protocol control, not device state at all.
 *   - "snapshot": the COMPLETE current value of its field group — always safe to
 *     replace whatever SupremeOS had cached, used after connect/reconnect/subscription
 *     restoration (§10) so stale pre-disconnect state can never survive reconciliation.
 *   - "delta": a PARTIAL update that must be merged onto an existing snapshot, sent
 *     only during steady-state operation — never the first message about a given media
 *     session (a delta before a snapshot exists is meaningless and must be rejected by
 *     the receiving layer, not guessed at).
 *   - "notification": a complete, self-contained current value, same as a snapshot in
 *     shape, but pushed on every change rather than only after reconnect (foregroundApp
 *     has no separate "changed" delta type — every foregroundApp message already is
 *     the full current answer, so there's nothing to merge).
 */
export type AgentMessageSemantics = "request" | "response" | "snapshot" | "delta" | "notification";

const MESSAGE_SEMANTICS: Record<AgentMessage["messageType"], AgentMessageSemantics> = {
  hello: "request",
  pair: "request",
  authenticated: "response",
  heartbeat: "request",
  deviceInfo: "snapshot",
  appInventory: "snapshot",
  mediaSession: "snapshot",
  foregroundApp: "notification",
  mediaStateChanged: "delta",
  mediaMetadataChanged: "delta",
  mediaCapabilitiesChanged: "delta",
  volumeChanged: "notification",
  error: "notification",
  goodbye: "notification",
};

export function agentMessageSemantics(messageType: AgentMessage["messageType"]): AgentMessageSemantics {
  return MESSAGE_SEMANTICS[messageType];
}

/** §10 — exactly the messages a reconnect/subscription-restoration sequence must
 * request/expect before trusting any delta, in the documented order. */
export const AGENT_RECONNECT_SNAPSHOT_SEQUENCE: readonly AgentMessage["messageType"][] = ["deviceInfo", "appInventory", "foregroundApp", "mediaSession"];

/** The full discriminated union of every wire message this protocol version defines
 * (§2's required list) — an unrecognized `messageType` is a validation failure, not a
 * silently-ignored unknown arm (unlike RemoteMessage's envelope arms, which
 * intentionally tolerate future additions from third-party firmware — the Agent
 * protocol is entirely SupremeOS's own, so there is no reason to be lenient here). */
export type AgentMessage = EnvelopeFields &
  (
    | { messageType: "hello"; payload: { agentVersion: string } }
    | { messageType: "pair"; payload: { pairingCode: string } }
    | { messageType: "authenticated"; payload: Record<string, never> }
    | { messageType: "heartbeat"; payload: Record<string, never> }
    | { messageType: "deviceInfo"; payload: AgentDeviceInfoPayload }
    | { messageType: "appInventory"; payload: { apps: AgentAppInventoryEntry[] } }
    | { messageType: "foregroundApp"; payload: AgentForegroundAppPayload }
    | { messageType: "mediaSession"; payload: AgentMediaSessionPayload }
    | { messageType: "mediaStateChanged"; payload: Pick<AgentMediaSessionPayload, "playbackState" | "playbackPositionMs" | "confidence" | "sessionRevision"> }
    | { messageType: "mediaMetadataChanged"; payload: Omit<AgentMediaSessionPayload, "playbackState" | "playbackPositionMs" | "playbackSpeed"> }
    | { messageType: "mediaCapabilitiesChanged"; payload: { supportedActions: string[]; customActions: string[] } }
    | { messageType: "volumeChanged"; payload: { volumePercent: number; muted: boolean } }
    | { messageType: "error"; payload: { code: string; message: string } }
    | { messageType: "goodbye"; payload: { reason: string } }
  );

export type ParsedAgentMessage = { ok: true; message: AgentMessage } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** §2/§4 — `hello`/`pair` precede any session, so they alone may omit `sessionId`/
 * `sequenceNumber`; every other message type requires both (checked by the caller,
 * which knows `messageType`). */
const MESSAGE_TYPES_WITHOUT_SESSION = new Set(["hello", "pair"]);

function validateEnvelope(raw: Record<string, unknown>, messageType: unknown): string | null {
  if (typeof raw.protocolVersion !== "number" || !Number.isInteger(raw.protocolVersion) || raw.protocolVersion <= 0) return "protocolVersion must be a positive integer";
  if (raw.protocolMinor !== undefined && (typeof raw.protocolMinor !== "number" || !Number.isInteger(raw.protocolMinor) || raw.protocolMinor < 0)) {
    return "protocolMinor must be a non-negative integer when present";
  }
  if (!isNonEmptyString(raw.agentId)) return "agentId must be a non-empty string";
  if (!isNonEmptyString(raw.deviceId)) return "deviceId must be a non-empty string";
  if (!isNonEmptyString(raw.messageId)) return "messageId must be a non-empty string";
  if (typeof raw.timestamp !== "string" || Number.isNaN(Date.parse(raw.timestamp))) return "timestamp must be an ISO-8601 string";
  if (typeof messageType === "string" && !MESSAGE_TYPES_WITHOUT_SESSION.has(messageType)) {
    if (!isNonEmptyString(raw.sessionId)) return `${messageType}.sessionId required — every message after pairing must belong to an authenticated session`;
    if (typeof raw.sequenceNumber !== "number" || !Number.isInteger(raw.sequenceNumber) || raw.sequenceNumber < 0) {
      return `${messageType}.sequenceNumber must be a non-negative integer — required for replay/duplicate protection`;
    }
  }
  return null;
}

const MEDIA_CONFIDENCE_VALUES: MediaConfidence[] = ["exact", "metadata", "app_only", "unknown"];
const FOREGROUND_SOURCE_VALUES: ForegroundSource[] = ["agent_accessibility", "platform_foreground_api", "adb", "last_known"];
const PLAYBACK_STATE_VALUES = ["playing", "paused", "stopped", "idle", "buffering", "error"];

/** §6 field-length/count checks a `string`/`string[]` field must satisfy — returns an
 * error string or null, never throws on the wrong runtime type (callers already
 * checked required-ness/type; this only bounds size for a value already known valid). */
function checkLength(label: string, value: string | null | undefined, max: number): string | null {
  if (typeof value === "string" && value.length > max) return `${label} exceeds maximum length ${max} (got ${value.length})`;
  return null;
}

function checkArrayLength(label: string, value: unknown[], max: number): string | null {
  if (value.length > max) return `${label} exceeds maximum entries ${max} (got ${value.length})`;
  return null;
}

function validateMediaSessionPayload(p: Record<string, unknown>, opts: { requirePlaybackFields: boolean } = { requirePlaybackFields: true }): string | null {
  if (!isNonEmptyString(p.packageName)) return "mediaSession.packageName must be a non-empty string";
  if (opts.requirePlaybackFields) {
    if (typeof p.playbackState !== "string" || !PLAYBACK_STATE_VALUES.includes(p.playbackState)) return "mediaSession.playbackState invalid";
    if (p.playbackPositionMs !== null && typeof p.playbackPositionMs !== "number") return "mediaSession.playbackPositionMs must be number|null";
  }
  if (typeof p.confidence !== "string" || !MEDIA_CONFIDENCE_VALUES.includes(p.confidence as MediaConfidence)) return "mediaSession.confidence invalid";
  if (p.sessionRevision !== null && typeof p.sessionRevision !== "number") return "mediaSession.sessionRevision must be number|null";

  // §6/§12/§13 — bounded metadata/URI/queue field sizes; a misbehaving app must never
  // be able to balloon memory through an oversized title, artist, or artwork URI.
  return (
    checkLength("mediaSession.packageName", p.packageName as string, AGENT_LIMITS.maxPackageNameLength) ||
    checkLength("mediaSession.applicationName", p.applicationName as string | null, AGENT_LIMITS.maxApplicationNameLength) ||
    checkLength("mediaSession.title", p.title as string | null, AGENT_LIMITS.maxMetadataFieldLength) ||
    checkLength("mediaSession.displayTitle", p.displayTitle as string | null, AGENT_LIMITS.maxMetadataFieldLength) ||
    checkLength("mediaSession.subtitle", p.subtitle as string | null, AGENT_LIMITS.maxMetadataFieldLength) ||
    checkLength("mediaSession.artist", p.artist as string | null, AGENT_LIMITS.maxMetadataFieldLength) ||
    checkLength("mediaSession.album", p.album as string | null, AGENT_LIMITS.maxMetadataFieldLength) ||
    checkLength("mediaSession.genre", p.genre as string | null, AGENT_LIMITS.maxMetadataFieldLength) ||
    checkLength("mediaSession.queueTitle", p.queueTitle as string | null, AGENT_LIMITS.maxMetadataFieldLength) ||
    checkLength("mediaSession.mediaId", p.mediaId as string | null, AGENT_LIMITS.maxMediaIdLength) ||
    checkLength("mediaSession.mediaUri", p.mediaUri as string | null, AGENT_LIMITS.maxUriLength) ||
    checkLength("mediaSession.artworkUri", p.artworkUri as string | null, AGENT_LIMITS.maxUriLength) ||
    (Array.isArray(p.supportedActions) ? checkArrayLength("mediaSession.supportedActions", p.supportedActions, AGENT_LIMITS.maxSupportedActionsEntries) : null) ||
    (Array.isArray(p.customActions) ? checkArrayLength("mediaSession.customActions", p.customActions, AGENT_LIMITS.maxCustomActionsEntries) : null) ||
    null
  );
}

/** Parses and validates one wire message already decoded from JSON (an object, not a
 * string) — see `parseAgentMessageFromJson` for the wire entry point that also enforces
 * §6's byte-size limit before this ever runs. Never throws — a malformed message is a
 * normal, expected occurrence on this channel (§21 "malformed message" is an explicit
 * test-double scenario, not an exceptional path), so callers get a typed result instead
 * of having to wrap every parse in try/catch. */
export function parseAgentMessage(raw: unknown): ParsedAgentMessage {
  if (!isPlainObject(raw)) return { ok: false, error: "message must be a JSON object" };
  const envelopeError = validateEnvelope(raw, raw.messageType);
  if (envelopeError) return { ok: false, error: envelopeError };
  if (!isCompatibleProtocolMajor(raw.protocolVersion as number)) {
    return { ok: false, error: `incompatible protocolVersion ${String(raw.protocolVersion)} (this build speaks major ${AGENT_PROTOCOL_VERSION}; minor differences are tolerated, major differences are not)` };
  }
  if (typeof raw.messageType !== "string") return { ok: false, error: "messageType must be a string" };
  if (!isPlainObject(raw.payload)) return { ok: false, error: "payload must be a JSON object" };
  const payload = raw.payload;

  switch (raw.messageType) {
    case "hello":
      if (!isNonEmptyString(payload.agentVersion)) return { ok: false, error: "hello.payload.agentVersion required" };
      break;
    case "pair":
      if (!isNonEmptyString(payload.pairingCode)) return { ok: false, error: "pair.payload.pairingCode required" };
      break;
    case "authenticated":
    case "heartbeat":
      break;
    case "deviceInfo": {
      const osNames: AgentOsName[] = ["android_tv", "google_tv", "fire_os", "vega_os", "unknown"];
      if (typeof payload.osName !== "string" || !osNames.includes(payload.osName as AgentOsName)) return { ok: false, error: "deviceInfo.payload.osName invalid" };
      if (!isNonEmptyString(payload.agentVersion)) return { ok: false, error: "deviceInfo.payload.agentVersion required" };
      if (!Array.isArray(payload.supportedFeedbackMechanisms)) return { ok: false, error: "deviceInfo.payload.supportedFeedbackMechanisms must be an array" };
      break;
    }
    case "appInventory": {
      // §11 App inventory scale — bounded entry count and per-entry field lengths; a
      // device with an unusually large number of installed apps (or a hostile Agent)
      // must never be able to force an unbounded array through this channel.
      if (!Array.isArray(payload.apps)) return { ok: false, error: "appInventory.payload.apps must be an array" };
      const countErr = checkArrayLength("appInventory.payload.apps", payload.apps, AGENT_LIMITS.maxAppInventoryEntries);
      if (countErr) return { ok: false, error: countErr };
      for (const app of payload.apps) {
        if (!isPlainObject(app) || !isNonEmptyString(app.packageName)) return { ok: false, error: "appInventory entry missing packageName" };
        // §8/§20 "do not assume every installed package has a friendly application
        // label" — applicationName may legitimately be null/absent.
        const lenErr =
          checkLength("appInventory entry packageName", app.packageName as string, AGENT_LIMITS.maxPackageNameLength) ||
          checkLength("appInventory entry applicationName", app.applicationName as string | null, AGENT_LIMITS.maxApplicationNameLength);
        if (lenErr) return { ok: false, error: lenErr };
      }
      break;
    }
    case "foregroundApp":
      if (typeof payload.source !== "string" || !FOREGROUND_SOURCE_VALUES.includes(payload.source as ForegroundSource)) return { ok: false, error: "foregroundApp.payload.source invalid" };
      if (typeof payload.confidence !== "string" || !MEDIA_CONFIDENCE_VALUES.includes(payload.confidence as MediaConfidence)) return { ok: false, error: "foregroundApp.payload.confidence invalid" };
      break;
    case "mediaSession": {
      const err = validateMediaSessionPayload(payload);
      if (err) return { ok: false, error: err };
      break;
    }
    case "mediaStateChanged": {
      const err = validateMediaSessionPayload(payload, { requirePlaybackFields: true });
      if (err) return { ok: false, error: err };
      break;
    }
    case "mediaMetadataChanged": {
      const err = validateMediaSessionPayload(payload, { requirePlaybackFields: false });
      if (err) return { ok: false, error: err };
      break;
    }
    case "mediaCapabilitiesChanged": {
      if (!Array.isArray(payload.supportedActions) || !Array.isArray(payload.customActions)) return { ok: false, error: "mediaCapabilitiesChanged payload malformed" };
      const err =
        checkArrayLength("mediaCapabilitiesChanged.supportedActions", payload.supportedActions, AGENT_LIMITS.maxSupportedActionsEntries) ||
        checkArrayLength("mediaCapabilitiesChanged.customActions", payload.customActions, AGENT_LIMITS.maxCustomActionsEntries);
      if (err) return { ok: false, error: err };
      break;
    }
    case "volumeChanged":
      if (typeof payload.volumePercent !== "number" || payload.volumePercent < 0 || payload.volumePercent > 100) return { ok: false, error: "volumeChanged.payload.volumePercent must be 0-100" };
      if (typeof payload.muted !== "boolean") return { ok: false, error: "volumeChanged.payload.muted must be boolean" };
      break;
    case "error":
      if (!isNonEmptyString(payload.code) || typeof payload.message !== "string") return { ok: false, error: "error payload malformed" };
      break;
    case "goodbye":
      if (typeof payload.reason !== "string") return { ok: false, error: "goodbye.payload.reason must be a string" };
      break;
    default:
      return { ok: false, error: `unrecognized messageType "${raw.messageType}"` };
  }

  return { ok: true, message: raw as unknown as AgentMessage };
}

/** §6 wire entry point — checks the raw byte size BEFORE `JSON.parse` even runs, so an
 * oversized/malicious payload is rejected without ever allocating the parsed object
 * graph (the exact same discipline as Remote v2's `MAX_FRAME_SIZE` check happening
 * before a frame's payload is buffered — see framed-socket.ts). Use this for anything
 * arriving over a real transport; `parseAgentMessage` alone is for already-decoded
 * objects (e.g. test doubles that skip serialization entirely). */
export function parseAgentMessageFromJson(raw: string | Buffer): ParsedAgentMessage {
  const byteLength = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.length;
  if (byteLength > AGENT_LIMITS.maxMessageBytes) {
    return { ok: false, error: `message size ${byteLength} bytes exceeds maxMessageBytes (${AGENT_LIMITS.maxMessageBytes})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  return parseAgentMessage(parsed);
}
