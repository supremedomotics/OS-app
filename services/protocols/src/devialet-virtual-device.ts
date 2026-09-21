import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * § D16 — reusable, TEST-ONLY Devialet R1/CISettings virtual device farm. NOT shipped
 * protocol code (no import from `devialet-driver.ts`/`devialet-ip-control-client.ts`/
 * `devialet-cisettings-client.ts` in either direction) — a stateful in-process HTTP
 * fake that speaks exactly the wire shapes those real clients already send/expect, so
 * `DevialetProtocolDriver` can be exercised against realistic, controllable HTTP
 * behavior without physical Devialet hardware.
 *
 * Every earlier Devialet test file already builds its own small inline `node:http`
 * fixture (`devialet-driver-media.test.ts`'s `deviceServer()`/`startHttp()`,
 * `devialet-driver-lifecycle.test.ts`'s per-test servers, `devialet-driver-
 * topology-refresh.test.ts`'s `startDeviceServer()`, `devialet-driver-cisettings.
 * test.ts`'s fixture). This module generalizes that exact pattern into one reusable,
 * STATEFUL class rather than inventing a second, competing test-server framework —
 * it uses the same `node:http createServer` primitive every other Devialet test file
 * already uses, just with real per-field mutation methods and failure injection
 * instead of a fixed closure-captured object.
 *
 * § Strict mode (§17 of the brief) — an unrecognized path is the whole POINT of this
 * class existing: it is how an accidental protocol expansion (the driver suddenly
 * calling an endpoint nothing in D3/D4 ever documented) gets CAUGHT instead of
 * silently succeeding against a permissive fake. `strictViolations` records every
 * such hit; `assertNoStrictViolations()` is the test-facing failure point.
 */

// ── Wire shapes — copied verbatim from the REAL clients' own types, never expanded ──
// (devialet-ip-control-client.ts / devialet-cisettings-client.ts). This module does
// not import those files (kept test-only/protocol-independent per its own doc above),
// so the handful of literal unions below are intentionally duplicated, not re-used.

export type VirtualPlayingState = "playing" | "paused";
export type VirtualMuteState = "muted" | "unmuted";
export type VirtualPlaybackOp = "play" | "pause" | "next" | "previous" | "seek";
export type VirtualSourceType =
  | "phono" | "line" | "digital_left" | "digital_right" | "optical" | "opticaljack"
  | "spotifyconnect" | "airplay2" | "bluetooth" | "upnp" | "raat";

export interface VirtualDevialetSource {
  sourceId: string;
  deviceId: string;
  type: VirtualSourceType;
}

export interface VirtualDevialetMetadata {
  artist: string;
  album: string;
  title: string;
  coverArtUrl?: string;
}

/** One R1 logical error code the simulator can be told to return (HTTP 200 body
 * `{error:{code,message?}}`) — the exact set the real client/driver already classify
 * (`KNOWN_DEVIALET_ERROR_CODES` in `devialet-ip-control-client.ts`), never expanded. */
export type VirtualLogicalErrorCode =
  | "Error" | "UnreachableDevices" | "UnreachableDevice" | "UnreachableSource"
  | "Timeout" | "NoCurrentSource" | "InvalidValue" | "SystemLeaderAbsent"
  | "PlaybackNoStream" | "PlaybackOperationNotAvailable";

/** Per-request-pattern failure injection. `matcher` is matched against the
 * REQUEST-RELATIVE path (e.g. "/groups/current/sources/current"), substring match —
 * simple and sufficient for every real driver call site, never a routing DSL. */
export type VirtualFailureMode =
  | { kind: "http-status"; status: number }
  | { kind: "logical-error"; code: VirtualLogicalErrorCode; message?: string }
  | { kind: "malformed-json" }
  | { kind: "empty-body" }
  | { kind: "truncated" }
  | { kind: "missing-field"; field: string }
  | { kind: "wrong-type"; field: string }
  | { kind: "socket-reset" };

interface PendingFailure {
  matcher: string;
  mode: VirtualFailureMode;
  /** `Infinity` = every matching request until cleared; a number = consumed after N hits. */
  remaining: number;
}

/**
 * One physical virtual Devialet speaker. Owns its own mutable R1 + CISettings state
 * and its own failure-injection queue — never shared across instances (mirrors the
 * real driver's own per-device isolation, so a farm test can prove it, not just
 * assert it by convention).
 */
export class VirtualDevialetDevice {
  readonly deviceId: string;
  readonly model: string;
  readonly serial: string;
  readonly deviceName: string;
  readonly role: string | null;
  /** `null` for an accessory or an intentionally-unresolved speaker — matches the
   * real `DevialetDeviceInfo.systemId`/`groupId` absence semantics exactly. */
  systemId: string | null;
  groupId: string | null;
  systemName: string | null;

  volume = 50;
  playingState: VirtualPlayingState = "playing";
  muteState: VirtualMuteState = "unmuted";
  /** `undefined` = no current source at all (R1's own `NoCurrentSource` case, when
   * `noCurrentSource` below is also true) or a source with no metadata. */
  source: VirtualDevialetSource | undefined;
  metadata: VirtualDevialetMetadata | undefined;
  availableOperations: VirtualPlaybackOp[] = ["play", "pause", "next", "previous"];
  /** When true, `GET .../sources/current` returns the real `NoCurrentSource` LOGICAL
   * error (§9 of the brief) — a confirmed "nothing playing" answer, never conflated
   * with a transport failure (see `failNext()`, a completely separate mechanism). */
  noCurrentSource = false;

  // ── CISettings' own, independently-mutable mirror (§14) ────────────────────────
  ciVolume = 50;
  ciMuteMode = false;
  ciSource = "";
  ciPowerState: "standby" | "starting" | "running" | "stopping" = "running";
  ciInternalState = "OK";

  latencyMs = 0;
  private readonly pending: PendingFailure[] = [];
  readonly requestLog: string[] = [];

  constructor(opts: {
    deviceId: string;
    model?: string;
    serial?: string;
    deviceName?: string;
    role?: string | null;
    systemId?: string | null;
    groupId?: string | null;
    systemName?: string | null;
  }) {
    this.deviceId = opts.deviceId;
    this.model = opts.model ?? "Phantom I";
    this.serial = opts.serial ?? `S-${opts.deviceId}`;
    this.deviceName = opts.deviceName ?? opts.deviceId;
    this.role = opts.role ?? "Mono";
    this.systemId = opts.systemId ?? null;
    this.groupId = opts.groupId ?? null;
    this.systemName = opts.systemName ?? null;
    this.source = { sourceId: "src-1", deviceId: opts.deviceId, type: "airplay2" };
    this.metadata = { artist: "Artist", album: "Album", title: "Track" };
  }

  // ── Scenario-shaping mutators (§16 of the brief) ────────────────────────────────
  setVolume(v: number): void {
    this.volume = v;
  }
  setPlayback(state: VirtualPlayingState): void {
    this.playingState = state;
  }
  setMuted(muted: boolean): void {
    this.muteState = muted ? "muted" : "unmuted";
  }
  setMetadata(meta: VirtualDevialetMetadata | undefined): void {
    this.metadata = meta;
  }
  setSource(source: VirtualDevialetSource | undefined): void {
    this.source = source;
  }
  setAvailableOperations(ops: VirtualPlaybackOp[]): void {
    this.availableOperations = ops;
  }
  setTopology(t: { systemId: string | null; groupId: string | null; role?: string | null; systemName?: string | null }): void {
    this.systemId = t.systemId;
    this.groupId = t.groupId;
    if (t.systemName !== undefined) this.systemName = t.systemName;
  }
  setLatency(ms: number): void {
    this.latencyMs = ms;
  }
  /** Injects a failure for the NEXT `count` requests whose path CONTAINS `matcher`
   * (e.g. `"soundControl/volume"`, `"sources/current"`, `"/cisettings/volume"`).
   * `count: Infinity` (the default) keeps failing every matching request until
   * `clearFailures()` — a real, standing outage, not a single blip. */
  failNext(matcher: string, mode: VirtualFailureMode, count = Infinity): void {
    this.pending.push({ matcher, mode, remaining: count });
  }
  clearFailures(): void {
    this.pending.length = 0;
  }

  /** Consumes and returns the first still-pending failure whose matcher is contained
   * in `path`, decrementing/removing it — `undefined` if this request is healthy. */
  private takeFailure(path: string): VirtualFailureMode | undefined {
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]!;
      if (path.includes(p.matcher)) {
        p.remaining -= 1;
        if (p.remaining <= 0) this.pending.splice(i, 1);
        return p.mode;
      }
    }
    return undefined;
  }

  /** Handles one request already routed to THIS device by the farm. Returns `null`
   * for "path not recognized by this device" (the farm's strict-mode logic decides
   * what that means) rather than a fake 200 — this class never guesses. */
  async handle(method: string, path: string, body: unknown): Promise<{ status: number; body: string } | "socket-reset" | null> {
    this.requestLog.push(`${method} ${path}`);
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    const failure = this.takeFailure(path);
    if (failure) return this.applyFailure(failure);

    // ── R1 ─────────────────────────────────────────────────────────────────────
    if (path.endsWith("/devices/current") && method === "GET") {
      return this.ok({
        deviceId: this.deviceId,
        model: this.model,
        release: { version: "2.14.2" },
        serial: this.serial,
        deviceName: this.deviceName,
        ...(this.systemId ? { systemId: this.systemId } : {}),
        ...(this.groupId ? { groupId: this.groupId } : {}),
        ...(this.role ? { role: this.role } : {}),
      });
    }
    if (path.endsWith("/systems/current") && method === "GET") {
      return this.ok({ systemId: this.systemId, groupId: this.groupId, systemName: this.systemName ?? `${this.deviceId}'s room` });
    }
    if (path.endsWith("/systems/current/sources/current/soundControl/volume") && method === "GET") {
      return this.ok({ volume: this.volume });
    }
    if (path.endsWith("/systems/current/sources/current/soundControl/volume") && method === "POST") {
      const v = (body as { volume?: number } | undefined)?.volume;
      if (typeof v === "number") this.volume = v;
      this.muteState = "unmuted"; // § R1 doc — volume commands unmute the current source.
      return this.ok({});
    }
    if (path.endsWith("/groups/current/sources") && method === "GET") {
      return this.ok({ sources: this.source ? [this.source] : [] });
    }
    if (path.endsWith("/groups/current/sources/current") && method === "GET") {
      if (this.noCurrentSource) return this.logicalError("NoCurrentSource");
      if (!this.source) return this.logicalError("NoCurrentSource");
      return this.ok({
        source: this.source,
        playingState: this.playingState,
        muteState: this.muteState,
        ...(this.metadata ? { metadata: this.metadata } : {}),
        availableOperations: this.availableOperations,
      });
    }
    const playMatch = path.match(/\/groups\/current\/sources\/([^/]+)\/playback\/play$/);
    if (playMatch && method === "POST") {
      this.playingState = "playing";
      return this.ok({});
    }
    if (path.endsWith("/groups/current/sources/current/playback/pause") && method === "POST") {
      this.playingState = "paused";
      return this.ok({});
    }
    if (path.endsWith("/groups/current/sources/current/playback/mute") && method === "POST") {
      this.muteState = "muted";
      return this.ok({});
    }
    if (path.endsWith("/groups/current/sources/current/playback/unmute") && method === "POST") {
      this.muteState = "unmuted";
      return this.ok({});
    }
    if (path.endsWith("/groups/current/sources/current/playback/next") && method === "POST") {
      if (!this.availableOperations.includes("next")) return this.logicalError("PlaybackOperationNotAvailable");
      return this.ok({});
    }
    if (path.endsWith("/groups/current/sources/current/playback/previous") && method === "POST") {
      if (!this.availableOperations.includes("previous")) return this.logicalError("PlaybackOperationNotAvailable");
      return this.ok({});
    }

    // ── CISettings — fixed `/cisettings/<opcode>` shape ─────────────────────────
    if (path === "/cisettings/volume" && method === "GET") return this.ciEnvelope("volume", this.ciVolume);
    if (path === "/cisettings/volume" && method === "POST") {
      const v = (body as { volume?: number } | undefined)?.volume;
      if (typeof v === "number") this.ciVolume = v;
      return this.ok({});
    }
    if (path === "/cisettings/mutemode" && method === "GET") return this.ciEnvelope("mutemode", this.ciMuteMode ? "ON" : "OFF");
    if (path === "/cisettings/mutemode" && method === "POST") {
      const v = (body as { mutemode?: string } | undefined)?.mutemode;
      this.ciMuteMode = v === "ON";
      return this.ok({});
    }
    if (path === "/cisettings/source" && method === "GET") return this.ciEnvelope("source", this.ciSource);
    if (path === "/cisettings/source" && method === "POST") {
      const v = (body as { source?: string } | undefined)?.source;
      if (typeof v === "string") this.ciSource = v;
      return this.ok({});
    }
    if (path === "/cisettings/powerstate" && method === "GET") return this.ciEnvelope("powerstate", this.ciPowerState);
    if (path === "/cisettings/internalstate" && method === "GET") return this.ciEnvelope("internalstate", this.ciInternalState);

    return null; // unrecognized by this device — farm decides strict-mode outcome
  }

  private ok(json: unknown): { status: number; body: string } {
    return { status: 200, body: JSON.stringify(json) };
  }
  private ciEnvelope(opcode: string, value: unknown): { status: number; body: string } {
    return this.ok({ data: { [opcode]: value } });
  }
  private logicalError(code: VirtualLogicalErrorCode, message?: string): { status: number; body: string } {
    return { status: 200, body: JSON.stringify({ error: { code, ...(message ? { message } : {}) } }) };
  }

  private applyFailure(mode: VirtualFailureMode): { status: number; body: string } | "socket-reset" {
    switch (mode.kind) {
      case "http-status":
        return { status: mode.status, body: "" };
      case "logical-error":
        return this.logicalError(mode.code, mode.message);
      case "malformed-json":
        return { status: 200, body: "{not valid json" };
      case "empty-body":
        return { status: 200, body: "" };
      case "truncated":
        return { status: 200, body: '{"volume": 5' };
      case "missing-field":
        return { status: 200, body: JSON.stringify({}) };
      case "wrong-type":
        return { status: 200, body: JSON.stringify({ [mode.field]: { unexpected: "object" } }) };
      case "socket-reset":
        return "socket-reset";
    }
  }
}

export interface DevialetVirtualDeviceFarmOptions {
  /** § D16-17 — when true (the default), a request path none of the farm's devices
   * recognize is a hard failure (HTTP 599 + recorded in `strictViolations`) instead
   * of a permissive fallback `{}` — the whole point of this class per its own module
   * doc. Set `false` only for a test that deliberately wants to observe the driver's
   * OWN malformed-response handling for a genuinely uncovered path. */
  strict?: boolean;
}

/**
 * Hosts one or more {@link VirtualDevialetDevice}s, each on its OWN real
 * `node:http` server/port — mirrors a real installation's per-speaker IP exactly
 * (never one shared server dispatching by a path prefix, which no real Devialet
 * deployment could produce). One farm instance per test; always `close()` it.
 */
export class DevialetVirtualDeviceFarm {
  private readonly servers: Server[] = [];
  private readonly strict: boolean;
  readonly strictViolations: string[] = [];

  constructor(opts: DevialetVirtualDeviceFarmOptions = {}) {
    this.strict = opts.strict ?? true;
  }

  /** Starts a real HTTP server bound to `device`. Returns the base URL to hand to
   * `DevialetProtocolDriver`'s `bind()`/CISettings host. */
  async addDevice(device: VirtualDevialetDevice): Promise<{ base: string }> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          let parsedBody: unknown;
          try {
            parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
          } catch {
            parsedBody = undefined;
          }
          const path = req.url ?? "";
          const method = req.method ?? "GET";
          const result = await device.handle(method, path, parsedBody);
          if (result === "socket-reset") {
            req.socket.destroy();
            return;
          }
          if (result === null) {
            this.strictViolations.push(`${device.deviceId}: ${method} ${path}`);
            if (this.strict) {
              res.statusCode = 599; // unmistakable, never a real Devialet/HTTP status
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ error: { code: "SimulatorStrictModeViolation", message: `unrecognized request: ${method} ${path}` } }));
              return;
            }
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end("{}");
            return;
          }
          res.statusCode = result.status;
          res.setHeader("content-type", "application/json");
          res.end(result.body);
        })();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.servers.push(server);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return { base: `http://127.0.0.1:${port}` };
  }

  /** A separate real HTTP server serving raw artwork bytes — mirrors the fact that
   * `coverArtUrl` is an arbitrary URL, not necessarily the same host/port as R1/
   * CISettings (matching every prior Devialet artwork test's own fixture shape). */
  async addArtworkServer(opts: { bytes: Buffer; contentType?: string; status?: number; latencyMs?: number }): Promise<{ base: string; hits: string[] }> {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      void (async () => {
        hits.push(req.url ?? "");
        if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
        res.statusCode = opts.status ?? 200;
        if ((opts.status ?? 200) === 200) {
          res.setHeader("content-type", opts.contentType ?? "image/jpeg");
          res.end(opts.bytes);
        } else {
          res.end();
        }
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.servers.push(server);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return { base: `http://127.0.0.1:${port}`, hits };
  }

  /** Fails the test (throws) if any device received a request outside this
   * simulator's known endpoint set — the strict-mode contract's assertion point. */
  assertNoStrictViolations(): void {
    if (this.strictViolations.length > 0) {
      throw new Error(`Devialet virtual device farm: unexpected request(s) outside the simulated protocol surface:\n${this.strictViolations.join("\n")}`);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  }
}

/**
 * A realistic mDNS TXT-record-shaped discovery candidate (§15 of the brief) — for
 * tests that want to exercise `devialet-discovery.ts`'s `parseDevialetCandidate()`
 * against a virtual device's own address, without duplicating that module's own
 * parsing logic here. Returns the raw fields; the caller passes them through the
 * REAL `MdnsService`-shaped object `parseDevialetCandidate()` expects.
 */
export function virtualDevialetMdnsTxt(device: { host: string; port: number; ipControlPath?: string; manufacturer?: string; ipControlVersion?: string }): Record<string, string> {
  return {
    manufacturer: device.manufacturer ?? "Devialet",
    ipControlVersion: device.ipControlVersion ?? "1",
    path: device.ipControlPath ?? "/ipcontrol/v1",
  };
}
