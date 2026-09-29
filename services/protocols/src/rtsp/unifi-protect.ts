import https from "node:https";
import { validateConsoleHost, validateRtspUrl } from "./rtsp-url-safety.js";
import { validateRtspStream } from "./rtsp-handshake.js";
import type { RtspStreamCheck } from "./rtsp-types.js";

/**
 * UniFi Protect console support (§ RTSP Camera Extension — UniFi Protect mode). The UniFi Protect
 * *Integration API* (`https://<console>/proxy/protect/integration/v1`, `X-API-KEY` header) lists
 * a console's cameras and hands out per-camera `rtsps://` URLs. This module only talks to that
 * API and turns its answers into ordinary RTSP stream URLs — persistence and streaming stay in
 * the existing CameraService/StreamGateway pipeline.
 *
 * Endpoint/field notes are taken from community clients that call the official API (Ubiquiti's
 * own developer.ui.com pages were not reachable when this was written) and are UNVERIFIED against
 * a real console: GET /cameras, GET|POST /cameras/{id}/rtsps-stream. Parsing is deliberately
 * tolerant (missing/extra fields never throw) and errors are plain English.
 *
 * Secrets: the API key exists only inside a request's headers here — it is never stored, logged,
 * returned, or included in an error message.
 */

export const UNIFI_API_BASE = "/proxy/protect/integration/v1";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;

/** Installer-safe failure. `message` is plain English; `diagnostics` is for a Diagnostics
 * affordance only and never contains the API key or an RTSPS token. */
export class UnifiProtectError extends Error {
  constructor(
    message: string,
    readonly kind: "bad-host" | "unreachable" | "auth" | "not-supported" | "rate-limited" | "unexpected",
    readonly diagnostics: string[] = [],
  ) {
    super(message);
  }
}

export interface UnifiHttpRequest {
  /** The validated, already-resolved private address that is actually connected to. */
  address: string;
  port: number;
  method: "GET" | "POST";
  path: string;
  apiKey: string;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}
export interface UnifiHttpResponse {
  status: number;
  body: string;
}
export type UnifiHttp = (req: UnifiHttpRequest) => Promise<UnifiHttpResponse>;

/** Real HTTPS transport. UniFi consoles present a self-signed certificate, so verification is
 * disabled — but ONLY through a fresh `https.Agent` created for this single request, connected to
 * the single private address the caller already validated. The process-wide TLS setting
 * (`NODE_TLS_REJECT_UNAUTHORIZED`, the global agent) is never touched. */
export const realUnifiHttp: UnifiHttp = (req) =>
  new Promise((resolve, reject) => {
    const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false, maxCachedSessions: 0 });
    const payload = req.body === undefined ? undefined : Buffer.from(req.body, "utf8");
    const request = https.request(
      {
        host: req.address,
        port: req.port,
        method: req.method,
        path: req.path,
        agent,
        timeout: req.timeoutMs,
        headers: {
          "X-API-KEY": req.apiKey,
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > req.maxBytes) {
            agent.destroy();
            reject(new Error("response too large"));
            request.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          agent.destroy();
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", (e) => {
          agent.destroy();
          reject(e);
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (e) => {
      agent.destroy();
      reject(e);
    });
    if (payload) request.write(payload);
    request.end();
  });

export interface UnifiConsoleTarget {
  address: string;
  port: number;
}

/** Validates the console address (private network only) and returns the address to connect to. */
export async function resolveConsole(rawHost: string): Promise<UnifiConsoleTarget> {
  const v = await validateConsoleHost(rawHost);
  if (!v.ok || !v.resolvedAddress) throw new UnifiProtectError(v.reason ?? "That console address isn't valid.", "bad-host");
  return { address: v.resolvedAddress, port: v.port };
}

async function call(
  target: UnifiConsoleTarget,
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  http: UnifiHttp,
): Promise<unknown> {
  let res: UnifiHttpResponse;
  try {
    res = await http({
      address: target.address,
      port: target.port,
      method,
      path: `${UNIFI_API_BASE}${path}`,
      apiKey,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? "error";
    throw new UnifiProtectError("Couldn't reach the UniFi console at that address. Check the address and that this hub is on the same network.", "unreachable", [
      `${method} ${UNIFI_API_BASE}${path} -> ${String(code)}`,
    ]);
  }
  const diag = [`${method} ${UNIFI_API_BASE}${path} -> HTTP ${res.status}`];
  if (res.status === 401 || res.status === 403) {
    throw new UnifiProtectError("The console rejected the API key. Create a new key in UniFi Protect and try again.", "auth", diag);
  }
  if (res.status === 404) {
    throw new UnifiProtectError(
      "This console doesn't offer the UniFi Protect Integration API. Update UniFi Protect, or check that the address is your UniFi console.",
      "not-supported",
      diag,
    );
  }
  if (res.status === 429) {
    throw new UnifiProtectError("The console is busy right now. Wait a moment and try again.", "rate-limited", diag);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new UnifiProtectError(`The console returned an unexpected response (HTTP ${res.status}).`, "unexpected", diag);
  }
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new UnifiProtectError("The console returned an answer this hub couldn't read.", "unexpected", [...diag, "response body was not valid JSON"]);
  }
}

export interface UnifiCameraSummary {
  id: string;
  name: string;
  model: string | null;
  state: string | null;
}

const CAMERA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Tolerant parse of `GET /cameras`: an array (or `{data: [...]}`); entries without a usable id
 * are skipped; every other field is optional. Only id/name/model/state are ever kept. */
export function parseUnifiCameras(json: unknown): UnifiCameraSummary[] {
  const list = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data) ? (json as { data: unknown[] }).data : null;
  if (!list) throw new UnifiProtectError("The console returned an answer this hub couldn't read.", "unexpected", ["camera list was not an array"]);
  const out: UnifiCameraSummary[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    if (!id || !CAMERA_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: str(o.name) ?? str(o.marketName) ?? "UniFi camera",
      model: str(o.marketName) ?? str(o.model) ?? str(o.type) ?? str(o.modelKey),
      state: str(o.state),
    });
  }
  return out;
}

export async function listUnifiCameras(opts: { host: string; apiKey: string; http?: UnifiHttp }): Promise<UnifiCameraSummary[]> {
  if (!opts.apiKey.trim()) throw new UnifiProtectError("Enter the UniFi API key.", "auth");
  const target = await resolveConsole(opts.host);
  return parseUnifiCameras(await call(target, opts.apiKey, "GET", "/cameras", undefined, opts.http ?? realUnifiHttp));
}

export type UnifiQuality = "high" | "medium" | "low";
export type UnifiStreamUrls = Partial<Record<UnifiQuality, string>>;

/** Tolerant parse of the rtsps-stream answer: an object mapping quality -> `rtsps://` URL, where
 * a disabled quality is null/absent. Anything that isn't an rtsp(s) string is ignored. */
export function parseUnifiStreams(json: unknown): UnifiStreamUrls {
  const src = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const out: UnifiStreamUrls = {};
  for (const q of ["high", "medium", "low"] as const) {
    const v = str(src[q]);
    if (v && /^rtsps?:\/\//i.test(v)) out[q] = v;
  }
  return out;
}

/** Existing per-quality URLs first (GET); only when the camera has none enabled is one created
 * (POST) — a POST can rotate a stream's token, so an already-enabled stream is never re-created. */
export async function getUnifiStreamUrls(opts: { target: UnifiConsoleTarget; apiKey: string; cameraId: string; http?: UnifiHttp }): Promise<UnifiStreamUrls> {
  if (!CAMERA_ID.test(opts.cameraId)) throw new UnifiProtectError("That camera id isn't valid.", "unexpected");
  const http = opts.http ?? realUnifiHttp;
  const path = `/cameras/${encodeURIComponent(opts.cameraId)}/rtsps-stream`;
  let urls: UnifiStreamUrls = {};
  try {
    urls = parseUnifiStreams(await call(opts.target, opts.apiKey, "GET", path, undefined, http));
  } catch (err) {
    if (!(err instanceof UnifiProtectError) || err.kind === "auth" || err.kind === "unreachable" || err.kind === "rate-limited") throw err;
    // Some firmware answers GET with an error until a stream exists — fall through to create one.
  }
  if (Object.keys(urls).length === 0) {
    urls = parseUnifiStreams(await call(opts.target, opts.apiKey, "POST", path, { qualities: ["high", "medium", "low"] }, http));
  }
  if (Object.keys(urls).length === 0) {
    throw new UnifiProtectError("The console didn't provide a stream for this camera. Enable RTSP for it in UniFi Protect.", "unexpected");
  }
  return urls;
}

/** main = highest available quality; substream = the next one down when the console has one. */
export function pickMainAndSub(urls: UnifiStreamUrls): { main: string; sub: string | null } {
  const ordered = (["high", "medium", "low"] as const).map((q) => urls[q]).filter((u): u is string => Boolean(u));
  return { main: ordered[0]!, sub: ordered[1] ?? null };
}

// ── Commissioning ────────────────────────────────────────────────────────────────

export interface UnifiCommissionResult {
  unifiCameraId: string;
  name: string;
  status: "added" | "already-added" | "failed";
  deviceId: string | null;
  /** Plain-English cause when `status` is "failed". */
  reason: string | null;
  diagnostics: string[];
}

export interface UnifiCommissionDeps {
  http?: UnifiHttp;
  validateStream?: (rtspUrl: string) => Promise<RtspStreamCheck>;
  validateUrl?: typeof validateRtspUrl;
  /** An already-commissioned camera for this UniFi camera id, if any (idempotency). */
  findExisting: (unifiCameraId: string) => Promise<{ deviceId: string } | null>;
  register: (input: { unifiCameraId: string; name: string; model: string | null; mainUrl: string; subUrl: string | null }) => Promise<{ deviceId: string }>;
}

/** Commissions each selected camera independently (sequentially — Protect rate-limits its API):
 * one failure is reported on that camera only and never stops the rest. The stream URLs contain
 * a secret token, so they are never placed in a result, diagnostic or error. */
export async function commissionUnifiCameras(opts: {
  host: string;
  apiKey: string;
  cameras: { id: string; name: string; model?: string | null }[];
  deps: UnifiCommissionDeps;
}): Promise<UnifiCommissionResult[]> {
  const { deps } = opts;
  if (!opts.apiKey.trim()) throw new UnifiProtectError("Enter the UniFi API key.", "auth");
  const target = await resolveConsole(opts.host);
  const validateStream = deps.validateStream ?? ((url) => validateRtspStream({ url }));
  const validateUrl = deps.validateUrl ?? validateRtspUrl;
  const results: UnifiCommissionResult[] = [];

  for (const cam of opts.cameras) {
    const base = { unifiCameraId: cam.id, name: cam.name };
    const fail = (reason: string, diagnostics: string[] = []) => results.push({ ...base, status: "failed", deviceId: null, reason, diagnostics });
    try {
      const existing = await deps.findExisting(cam.id);
      if (existing) {
        results.push({ ...base, status: "already-added", deviceId: existing.deviceId, reason: null, diagnostics: [] });
        continue;
      }
      const urls = await getUnifiStreamUrls({ target, apiKey: opts.apiKey, cameraId: cam.id, http: deps.http });
      const { main, sub } = pickMainAndSub(urls);
      const safe = await validateUrl(main);
      if (!safe.ok) {
        fail(safe.reason ?? "The console gave a stream address this hub won't connect to.");
        continue;
      }
      const check = await validateStream(main);
      if (!check.ok) {
        fail(check.reason ?? "The camera's stream didn't respond.", check.diagnostics);
        continue;
      }
      // Only offer a substream that is itself a safe, local address; otherwise drop it quietly.
      const subUrl = sub && (await validateUrl(sub)).ok ? sub : null;
      const reg = await deps.register({ unifiCameraId: cam.id, name: cam.name, model: cam.model ?? null, mainUrl: main, subUrl });
      results.push({ ...base, status: "added", deviceId: reg.deviceId, reason: null, diagnostics: [] });
    } catch (err) {
      if (err instanceof UnifiProtectError) fail(err.message, err.diagnostics);
      else fail("Could not add this camera.");
    }
  }
  return results;
}

