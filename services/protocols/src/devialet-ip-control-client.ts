/**
 * Devialet IP Control R1 client (§ D3) — a small, typed, injectable HTTP client for the
 * real protocol documented in "Devialet IP Control, Reference API Documentation,
 * Revision 1 - December 2021." Every endpoint, field, and error code below is taken
 * directly from that document; nothing here is inferred from third-party libraries,
 * Home Assistant, or reverse engineering. Where the document does not establish a
 * field/shape, this client does not invent one (see `getPlaybackPosition()`).
 *
 * This module is protocol-only: it knows nothing about SupremeOS capabilities,
 * `DriverDiagnosticsTracker`, or `ProtocolTracer` — `devialet-driver.ts` composes this
 * client and remains the one place that talks to the rest of the fleet's shared
 * infrastructure (§ D2/D3 boundary).
 */

// ── Discovery/endpoint addressing ──────────────────────────────────────────────────
/**
 * A resolved Devialet control endpoint. `path` is REQUIRED and deliberately has no
 * default anywhere in this file — the R1 doc explicitly warns "the /ipcontrol/v1 part
 * of the URL can change in the future. It is strongly recommended to use the value of
 * the path key of the txt record" (Discovery / The global prefix sections). Real mDNS
 * TXT-record extraction is D5's job; D3 callers (the driver's interim wiring, and every
 * test in this file) must construct this explicitly.
 */
export interface DevialetEndpoint {
  /** Transport host — an IP/hostname, optionally already including a scheme/port
   * (mirrors the pre-Fusion driver's own `host` binding field). Never the device's
   * permanent identity (§ D1/D2) — purely where this request is sent. */
  host: string;
  /** The mDNS TXT record's own `path` value, e.g. "/ipcontrol/v1". */
  path: string;
}

/** Per the doc: "The only supported {deviceId}/{systemId}/{groupId} today is
 * 'current'." Every method below defaults its id parameter to this literal — the
 * PHYSICAL device you're addressing is determined entirely by `endpoint.host` (the
 * dispatcher), never by passing a real UUID into the URL path. The parameter still
 * exists (typed as a plain string, not hardcoded away) purely so a future protocol
 * revision that lifts this restriction doesn't require an API-shape change here. */
const CURRENT = "current";

// ── Documented response/request models (§5/§6/§7/§9/§10 of the D3 brief) ───────────
// Every field below is named, typed, and marked optional/required exactly as the R1
// doc's own "GET response" sections document it — no speculative properties.

/** `/devices/{deviceId}` — General information (R1 doc, "Requests in /devices
 * namespace"). `systemId`/`groupId`/`role` are genuinely ABSENT (not merely empty) for
 * non-speaker accessories (Arch, Dialog) — modeled as optional properties, not
 * nullable, to match "field is absent" rather than "field is present but empty." */
export interface DevialetDeviceInfo {
  deviceId: string;
  /** Speakers only. */
  systemId?: string;
  /** Speakers only. */
  groupId?: string;
  model: string;
  release: { version: string };
  serial: string;
  /** Speakers only. One of "FrontLeft" | "FrontRight" | "Mono" per the doc, but kept
   * as a plain string here — the doc does not promise this list is exhaustive across
   * future products, and treating it as a closed enum would risk rejecting a real,
   * documented-elsewhere value from a future firmware. */
  role?: string;
  deviceName: string;
}

/** `/systems/{systemId}` — General information (R1 doc, "Requests in /systems
 * namespace"). `availableFeatures` is DOS >= 2.16 only — genuinely absent on 2.14.x,
 * not an empty array (the doc marks the whole field with a version gate, not just its
 * contents). */
export interface DevialetSystemInfo {
  systemId: string;
  groupId: string;
  systemName: string;
  /** [DOS >= 2.16]. Possible values include "equalizer", "nightMode" per the doc, but
   * — same reasoning as `DevialetDeviceInfo.role` — kept as `string[]`, not a closed
   * union, since the doc does not claim this list is exhaustive. */
  availableFeatures?: string[];
}

/** Source types exactly as enumerated in "Source types and stream sensing." Kept as a
 * union (not `string`) because the doc presents this specific list as the complete,
 * closed vocabulary for `type` — unlike `role`/`availableFeatures` above, which the doc
 * does NOT claim are exhaustive. */
export type DevialetSourceType =
  | "phono"
  | "line"
  | "digital_left"
  | "digital_right"
  | "optical"
  | "opticaljack"
  | "spotifyconnect"
  | "airplay2"
  | "bluetooth"
  | "upnp"
  | "raat";

export interface DevialetSourceRef {
  sourceId: string;
  deviceId: string;
  type: DevialetSourceType;
}

/** `/groups/{groupId}/sources` response. */
export interface DevialetGroupSources {
  sources: DevialetSourceRef[];
}

export type DevialetPlayingState = "playing" | "paused";
export type DevialetMuteState = "muted" | "unmuted";

/** `availableOperations` values, per "About playback commands and states." "mute"/
 * "unmute" are deliberately excluded — the doc states they are "always available" and
 * "not present in this list." */
export type DevialetPlaybackOperation = "play" | "pause" | "next" | "previous" | "seek";

/** `metadata` object — per the doc, `artist`/`album`/`title` are "always present" even
 * when empty (empty string, not absent); only the whole `metadata` object and
 * `coverArtUrl` within it may be genuinely absent. */
export interface DevialetMetadata {
  artist: string;
  album: string;
  title: string;
  coverArtUrl?: string;
}

/**
 * `/groups/{groupId}/sources/current` response.
 *
 * § Protocol ambiguity (flagged, not resolved by invention — see D3 report): the doc's
 * "General information" section for this endpoint documents `source` as ABSENT when
 * there is no current source (a normal 200 response), while the doc's own Error
 * Handling section separately states a request to this exact path with no current
 * source reports the `"NoCurrentSource"` LOGICAL error instead. Both are modeled here
 * without contradiction: `source` is optional (covers the first case) and
 * `DevialetApiError` with `logical.code === "NoCurrentSource"` can still be thrown by
 * `request()` (covers the second) — callers must handle both.
 */
export interface DevialetCurrentSource {
  /** Absent if there is no current source. */
  source?: DevialetSourceRef;
  playingState: DevialetPlayingState;
  muteState: DevialetMuteState;
  /** Absent if the current source does not provide metadata at all. */
  metadata?: DevialetMetadata;
  availableOperations: DevialetPlaybackOperation[];
}

// ── Error model (§17 of the D3 brief; R1 doc "Error handling") ─────────────────────

/** Which layer produced the failure — never conflated, per the D3 brief's explicit
 * requirement to distinguish transport failure / HTTP failure / logical API error. */
export type DevialetErrorKind = "transport" | "http" | "logical";

/** The R1 doc's own `error` object shape (200-OK "regular errors," and best-effort on
 * a 500). `code` is intentionally `string`, not a closed union — the doc explicitly
 * requires the client to "process [an unknown code] and show a generic error message"
 * rather than reject it. */
export interface DevialetLogicalErrorBody {
  code: string;
  message?: string;
  details?: unknown;
}

/** Error codes the R1 doc names explicitly, gathered here for reference/documentation
 * only — NEVER used to validate or restrict `DevialetLogicalErrorBody.code` (an
 * unrecognized code must remain representable, per the doc and per the D3 brief). Note
 * the doc itself uses both "UnreachableDevices" (plural, /systems and /devices
 * sections) and "UnreachableDevice" (singular, the Bluetooth-advertising section) as
 * apparently distinct strings — preserved here exactly as documented, not normalized,
 * since "fixing" an inconsistency in the vendor's own spec would be exactly the kind of
 * invented behavior this phase must avoid. */
export const KNOWN_DEVIALET_ERROR_CODES = [
  "Error",
  "UnreachableDevices",
  "UnreachableDevice",
  "UnreachableSource",
  "Timeout",
  "NoCurrentSource",
  "InvalidValue",
  "SystemLeaderAbsent",
  "PlaybackNoStream",
  "PlaybackOperationNotAvailable",
] as const;

export class DevialetApiError extends Error {
  readonly kind: DevialetErrorKind;
  readonly httpStatus?: number;
  readonly logical?: DevialetLogicalErrorBody;
  /** Set only for a `kind: "transport"` error caused by the request exceeding
   * `timeoutMs` — lets a caller distinguish "device unreachable in time" from other
   * transport failures (DNS/connection-refused/etc.) without string-matching. */
  readonly timedOut?: boolean;

  constructor(
    kind: DevialetErrorKind,
    message: string,
    opts: { httpStatus?: number; logical?: DevialetLogicalErrorBody; timedOut?: boolean } = {},
  ) {
    super(message);
    this.name = "DevialetApiError";
    this.kind = kind;
    this.httpStatus = opts.httpStatus;
    this.logical = opts.logical;
    this.timedOut = opts.timedOut;
  }
}

function isLogicalErrorBody(x: unknown): x is { error: DevialetLogicalErrorBody } {
  if (typeof x !== "object" || x === null || !("error" in x)) return false;
  const err = (x as { error: unknown }).error;
  return typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string";
}

// ── Client ──────────────────────────────────────────────────────────────────────────

export interface DevialetIpControlClientOptions {
  /** Injectable fetch (tests point at an in-process HTTP server); defaults to the
   * real global fetch. This client never calls the global `fetch` directly — every
   * call goes through this seam, matching the repository's DI convention. */
  fetchImpl?: typeof fetch;
  /**
   * Per-request timeout (ms). The R1 doc itself recommends this exact figure: "The
   * processing before the response is sent is allowed to take up to 500 ms on the
   * device... An additional delay of at least 500 ms (for a total timeout of 1000 ms)
   * is recommended" ("Request types and timeouts"). Default 1000 — cited from the
   * spec, not invented.
   */
  timeoutMs?: number;
}

/**
 * A clean, typed, injectable, transport-independent Devialet IP Control R1 client.
 * Owns HTTP mechanics + R1-specific error/response parsing only. Retries: none (§20 of
 * the D3 brief — no automatic retries of any kind here; that's a D9 concern once
 * command confirmation semantics exist). Coalescing/diagnostics: intentionally NOT
 * this client's job — see `devialet-driver.ts`'s own per-call instrumentation, which
 * wraps each of these methods individually so every real request stays observable to
 * `DriverDiagnosticsTracker`/`ProtocolTracer` without this client needing to know
 * either type exists.
 */
export class DevialetIpControlClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: DevialetIpControlClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 1000;
  }

  // ── /devices ──────────────────────────────────────────────────────────────────
  async getDevice(endpoint: DevialetEndpoint, deviceId: string = CURRENT): Promise<DevialetDeviceInfo> {
    return this.request<DevialetDeviceInfo>(endpoint, "GET", `/devices/${encodeURIComponent(deviceId)}`);
  }

  // ── /systems ──────────────────────────────────────────────────────────────────
  async getSystem(endpoint: DevialetEndpoint, systemId: string = CURRENT): Promise<DevialetSystemInfo> {
    return this.request<DevialetSystemInfo>(endpoint, "GET", `/systems/${encodeURIComponent(systemId)}`);
  }

  /** Volume is SYSTEM-level (R1 doc, "Volume" section: "All devices in the same
   * system share the same volume") — never per-device, never per-group. */
  async getVolume(endpoint: DevialetEndpoint, systemId: string = CURRENT): Promise<{ volume: number }> {
    return this.request<{ volume: number }>(endpoint, "GET", `/systems/${encodeURIComponent(systemId)}/sources/current/soundControl/volume`);
  }

  /** 0-100, per the doc. Note (R1 doc): "All volume commands unmute the current
   * source. On the other hand, they do not change the playingState." — this client
   * does not simulate that side effect; it is the device's own documented behavior,
   * observable on the next real state read. */
  async setVolume(endpoint: DevialetEndpoint, volume: number, systemId: string = CURRENT): Promise<void> {
    await this.request<Record<string, never>>(endpoint, "POST", `/systems/${encodeURIComponent(systemId)}/sources/current/soundControl/volume`, { volume });
  }

  async volumeUp(endpoint: DevialetEndpoint, systemId: string = CURRENT): Promise<void> {
    await this.request<Record<string, never>>(endpoint, "POST", `/systems/${encodeURIComponent(systemId)}/sources/current/soundControl/volumeUp`);
  }

  async volumeDown(endpoint: DevialetEndpoint, systemId: string = CURRENT): Promise<void> {
    await this.request<Record<string, never>>(endpoint, "POST", `/systems/${encodeURIComponent(systemId)}/sources/current/soundControl/volumeDown`);
  }

  // ── /groups ───────────────────────────────────────────────────────────────────
  async getGroupSources(endpoint: DevialetEndpoint, groupId: string = CURRENT): Promise<DevialetGroupSources> {
    return this.request<DevialetGroupSources>(endpoint, "GET", `/groups/${encodeURIComponent(groupId)}/sources`);
  }

  async getCurrentSource(endpoint: DevialetEndpoint, groupId: string = CURRENT): Promise<DevialetCurrentSource> {
    return this.request<DevialetCurrentSource>(endpoint, "GET", `/groups/${encodeURIComponent(groupId)}/sources/current`);
  }

  /**
   * `/groups/{groupId}/sources/current/playback/position` — named only in the doc's
   * "Sample implementation" polling checklist, with NO dedicated request/response
   * schema documented anywhere in this revision. Per the D3 brief's core rule ("if the
   * documentation does not establish something, mark it as unknown rather than
   * inventing behavior"), this returns the raw parsed JSON body untyped rather than a
   * fabricated interface. Still goes through the same error handling as every other
   * call (a logical error / HTTP failure here is real and typed; only the SUCCESS
   * shape is left unknown).
   */
  async getPlaybackPosition(endpoint: DevialetEndpoint, groupId: string = CURRENT): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(endpoint, "GET", `/groups/${encodeURIComponent(groupId)}/sources/current/playback/position`);
  }

  // ── Playback commands (R1 doc, "Playback") ──────────────────────────────────────
  /** Unlike every other playback command, `play` addresses a SPECIFIC `sourceId` in
   * its own path segment, never "current" — per the doc: "/groups/{groupId}/sources/
   * {sourceId}/playback/play." There is no "resume whatever is current" endpoint; a
   * caller that wants that must first read `getCurrentSource()`'s `source.sourceId`
   * (this client does not do that resolution itself — see `devialet-driver.ts`). */
  async play(endpoint: DevialetEndpoint, sourceId: string, groupId: string = CURRENT): Promise<void> {
    await this.request<Record<string, never>>(endpoint, "POST", `/groups/${encodeURIComponent(groupId)}/sources/${encodeURIComponent(sourceId)}/playback/play`);
  }

  /** § Important pause semantics (R1 doc, "About playback commands and states" +
   * `/playback/pause`): for a source that cannot semantically pause (e.g. "optical"),
   * the device accepts this call but MUTES instead — `playingState` stays "playing"
   * and `muteState` becomes "muted". This client does not assume or report
   * `playingState: "paused"` after calling this; the caller must re-read
   * `getCurrentSource()` for the real, authoritative state (§ D9 will formalize this
   * as command confirmation). */
  async pause(endpoint: DevialetEndpoint, groupId: string = CURRENT): Promise<void> {
    await this.request<Record<string, never>>(endpoint, "POST", `/groups/${encodeURIComponent(groupId)}/sources/current/playback/pause`);
  }

  async mute(endpoint: DevialetEndpoint, groupId: string = CURRENT): Promise<void> {
    await this.request<Record<string, never>>(endpoint, "POST", `/groups/${encodeURIComponent(groupId)}/sources/current/playback/mute`);
  }

  async unmute(endpoint: DevialetEndpoint, groupId: string = CURRENT): Promise<void> {
    await this.request<Record<string, never>>(endpoint, "POST", `/groups/${encodeURIComponent(groupId)}/sources/current/playback/unmute`);
  }

  /** Throws `DevialetApiError` with `logical.code === "PlaybackOperationNotAvailable"`
   * if the current source has no "Next" command (R1 doc) — this client does not
   * pre-check `availableOperations` itself; it reports the device's real answer. */
  async next(endpoint: DevialetEndpoint, groupId: string = CURRENT): Promise<void> {
    await this.request<Record<string, never>>(endpoint, "POST", `/groups/${encodeURIComponent(groupId)}/sources/current/playback/next`);
  }

  /** Same "PlaybackOperationNotAvailable" semantics as `next()`, for "Previous". */
  async previous(endpoint: DevialetEndpoint, groupId: string = CURRENT): Promise<void> {
    await this.request<Record<string, never>>(endpoint, "POST", `/groups/${encodeURIComponent(groupId)}/sources/current/playback/previous`);
  }

  // ── Core request/response/error handling ────────────────────────────────────────
  private baseUrl(endpoint: DevialetEndpoint): string {
    const host = endpoint.host.startsWith("http") ? endpoint.host.replace(/\/$/, "") : `http://${endpoint.host}`;
    const path = endpoint.path.startsWith("/") ? endpoint.path.replace(/\/$/, "") : `/${endpoint.path.replace(/\/$/, "")}`;
    return `${host}${path}`;
  }

  private async request<T>(endpoint: DevialetEndpoint, method: "GET" | "POST", pathSuffix: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl(endpoint)}${pathSuffix}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: method === "POST" ? { "content-type": "application/json" } : undefined,
        // § General format — "For commands with no parameters, the request body can
        // be either empty or contain an empty JSON object ({})." This client always
        // sends "{}" for a no-parameter POST rather than an empty body, since both
        // are documented as equally valid and "{}" is unambiguous to log/trace.
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new DevialetApiError("transport", `devialet: request to ${pathSuffix} timed out after ${this.timeoutMs}ms`, { timedOut: true });
      }
      throw new DevialetApiError("transport", `devialet: network failure calling ${pathSuffix} — ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(timer);

    if (!res.ok) {
      // § Error handling, codes 400/404/415/500/other. 400/404/415 bodies are
      // documented EMPTY; 500's body, if any, follows the same {error:{...}} shape as
      // a 200-logical-error but is explicitly "not part of the officially supported
      // API" — best-effort parse only, never required.
      let logical: DevialetLogicalErrorBody | undefined;
      try {
        const text = await res.text();
        if (text.length > 0) {
          const parsed = JSON.parse(text) as unknown;
          if (isLogicalErrorBody(parsed)) logical = parsed.error;
        }
      } catch {
        // Empty or non-JSON body on an HTTP-failure status is expected per the doc —
        // the HTTP status itself is already the authoritative signal here.
      }
      throw new DevialetApiError("http", `devialet: HTTP ${res.status} calling ${pathSuffix}`, { httpStatus: res.status, logical });
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      // § General format — "For commands with no parameters... the response bodies
      // for POST requests contain empty JSON objects" (never a truly empty body on a
      // 200), but tolerate one defensively rather than throwing on a body-less 200.
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new DevialetApiError("transport", `devialet: malformed JSON response from ${pathSuffix}`);
    }

    // § Core rule — "HTTP 200 != automatically successful operation." A 200 response
    // whose body is the documented {error:{code,...}} shape is a LOGICAL failure, not
    // a success, regardless of the HTTP status.
    if (isLogicalErrorBody(parsed)) {
      const { code, message, details } = parsed.error;
      throw new DevialetApiError("logical", `devialet: ${code}${message ? ` — ${message}` : ""}`, {
        httpStatus: res.status,
        logical: { code, message, details },
      });
    }

    return parsed as T;
  }
}
