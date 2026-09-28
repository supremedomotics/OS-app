import net from "node:net";
import { createHash } from "node:crypto";
import type { RtspStreamCheck } from "./rtsp-types.js";
import { validateRtspUrl } from "./rtsp-url-safety.js";

/**
 * Real RTSP validation (§ STEP 8 — "not just port 554 open"): TCP connect, an RTSP OPTIONS then
 * DESCRIBE exchange (RFC 2326 §10.1/10.2), RTSP Digest authentication (RFC 2617, the auth scheme
 * every real ONVIF/IP camera actually speaks) when the camera challenges, and a check that the
 * DESCRIBE response's SDP body actually advertises a video media line. Bare TCP text protocol —
 * no dependency, consistent with every other hand-rolled wire codec in this fleet.
 */
export interface RtspSocketLike {
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  close(): void;
}

export type RtspSocketFactory = (host: string, port: number, timeoutMs: number) => Promise<RtspSocketLike>;

export const realRtspSocket: RtspSocketFactory = (host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let settled = false;
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => {
      if (settled) return;
      settled = true;
      resolve({
        write: (data) => sock.write(data, "utf8"),
        onData: (cb) => sock.on("data", (chunk) => cb(chunk.toString("utf8"))),
        close: () => sock.destroy(),
      });
    });
    sock.once("timeout", () => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error("connection timed out"));
    });
    sock.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    sock.connect(port, host);
  });

function parseWwwAuthenticate(headers: string): { scheme: "digest" | "basic"; realm: string; nonce: string | null } | null {
  const m = headers.match(/WWW-Authenticate:\s*(Digest|Basic)\s+([^\r\n]+)/i);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase() as "digest" | "basic";
  const params = m[2]!;
  const realm = (params.match(/realm="([^"]*)"/i) ?? [])[1] ?? "";
  const nonce = (params.match(/nonce="([^"]*)"/i) ?? [])[1] ?? null;
  return { scheme, realm, nonce };
}

function digestAuthHeader(opts: {
  username: string;
  password: string;
  realm: string;
  nonce: string;
  method: string;
  uri: string;
}): string {
  const ha1 = createHash("md5").update(`${opts.username}:${opts.realm}:${opts.password}`).digest("hex");
  const ha2 = createHash("md5").update(`${opts.method}:${opts.uri}`).digest("hex");
  const response = createHash("md5").update(`${ha1}:${opts.nonce}:${ha2}`).digest("hex");
  return `Digest username="${opts.username}", realm="${opts.realm}", nonce="${opts.nonce}", uri="${opts.uri}", response="${response}"`;
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

/** One request/response over an already-open RTSP socket, collecting response text until the
 * headers section (`\r\n\r\n`) is seen AND, when a `Content-Length` header is present (as it
 * always is on a real DESCRIBE response's SDP body), until that many body bytes have actually
 * arrived — or `timeoutMs` elapses. Bounded and cancellable — a non-responding camera never hangs
 * commissioning (§ STEP 8/12). TCP doesn't preserve write boundaries, so a camera splitting
 * headers and the SDP body across two packets must not be parsed as an empty/incomplete body
 * (§ FINDING 2) — waiting on Content-Length, not just the delimiter, fixes that. */
function requestResponse(sock: RtspSocketLike, request: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("RTSP response timed out"));
    }, timeoutMs);
    sock.onData((chunk) => {
      if (settled) return;
      buf += chunk;
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headers = buf.slice(0, headerEnd);
      const lengthMatch = headers.match(/^Content-Length:\s*(\d+)/im);
      const contentLength = lengthMatch ? Number(lengthMatch[1]) : 0;
      const bodyBytesReceived = Buffer.byteLength(buf.slice(headerEnd + 4), "utf8");
      if (bodyBytesReceived < contentLength) return; // headers arrived, body still incomplete
      settled = true;
      clearTimeout(timer);
      resolve(buf);
    });
    sock.write(request);
  });
}

export interface ValidateRtspOptions {
  url: string;
  username?: string | null;
  password?: string | null;
  timeoutMs?: number;
  socketFactory?: RtspSocketFactory;
}

/**
 * Full RTSP stream validation: DESCRIBE (retrying once with Digest/Basic auth if the camera
 * challenges), checking the response is a real 200 with an SDP body that advertises video. Every
 * failure mode maps to one honest, plain-English `reason` (§ STEP 8) — technical detail (raw
 * status lines, exceptions) only ever lands in `diagnostics`.
 */
export async function validateRtspStream(opts: ValidateRtspOptions): Promise<RtspStreamCheck> {
  const checklist: { label: string; pass: boolean }[] = [];
  const diagnostics: string[] = [];
  const validation = await validateRtspUrl(opts.url);
  checklist.push({ label: "Valid RTSP URL", pass: validation.ok });
  if (!validation.ok || !validation.host) {
    return { ok: false, checklist, reason: validation.reason ?? "The RTSP URL is not valid.", diagnostics, codec: null };
  }

  const timeoutMs = opts.timeoutMs ?? 4000;
  const factory = opts.socketFactory ?? realRtspSocket;
  const uri = opts.url;
  const cseqBase = 1;

  let sock: RtspSocketLike;
  try {
    sock = await factory(validation.host, validation.port, timeoutMs);
  } catch (err) {
    diagnostics.push(err instanceof Error ? err.message : String(err));
    checklist.push({ label: "Reachable on the network", pass: false });
    return { ok: false, checklist, reason: "The camera could not be reached on the network.", diagnostics, codec: null };
  }
  checklist.push({ label: "Reachable on the network", pass: true });

  try {
    // OPTIONS first — confirms RTSP is actually spoken on this port (a webcam/HTTP service that
    // happens to have port 554 open would fail here honestly, rather than a false "connected").
    let res: string;
    try {
      res = await requestResponse(sock, `OPTIONS ${uri} RTSP/1.0\r\nCSeq: ${cseqBase}\r\n\r\n`, timeoutMs);
    } catch (err) {
      diagnostics.push(err instanceof Error ? err.message : String(err));
      checklist.push({ label: "RTSP is enabled on this address/port", pass: false });
      return { ok: false, checklist, reason: "This doesn't look like an RTSP camera at that address and port.", diagnostics, codec: null };
    }
    const optionsOk = /^RTSP\/1\.0 200/.test(res);
    checklist.push({ label: "RTSP is enabled on this address/port", pass: optionsOk });
    if (!optionsOk) {
      diagnostics.push(res.split("\r\n")[0] ?? "no status line");
      return { ok: false, checklist, reason: "RTSP does not appear to be enabled on this camera.", diagnostics, codec: null };
    }

    let describe = await requestResponse(sock, `DESCRIBE ${uri} RTSP/1.0\r\nCSeq: ${cseqBase + 1}\r\nAccept: application/sdp\r\n\r\n`, timeoutMs);
    let authAttempted = false;

    if (/^RTSP\/1\.0 401/.test(describe)) {
      authAttempted = true;
      const hasCreds = Boolean(opts.username && opts.password);
      checklist.push({ label: "Credentials accepted", pass: false });
      if (!hasCreds) {
        return { ok: false, checklist, reason: "This camera requires a username and password.", diagnostics, codec: null };
      }
      const challenge = parseWwwAuthenticate(describe);
      const authHeader =
        challenge?.scheme === "digest" && challenge.nonce
          ? digestAuthHeader({ username: opts.username!, password: opts.password!, realm: challenge.realm, nonce: challenge.nonce, method: "DESCRIBE", uri })
          : basicAuthHeader(opts.username!, opts.password!);
      describe = await requestResponse(
        sock,
        `DESCRIBE ${uri} RTSP/1.0\r\nCSeq: ${cseqBase + 2}\r\nAccept: application/sdp\r\nAuthorization: ${authHeader}\r\n\r\n`,
        timeoutMs,
      );
      const authOk = /^RTSP\/1\.0 200/.test(describe);
      checklist[checklist.length - 1] = { label: "Credentials accepted", pass: authOk };
      if (!authOk) {
        diagnostics.push(describe.split("\r\n")[0] ?? "no status line");
        return { ok: false, checklist, reason: "The username or password was rejected by the camera.", diagnostics, codec: null };
      }
    } else {
      checklist.push({ label: "Credentials accepted", pass: true });
    }

    const describeOk = /^RTSP\/1\.0 200/.test(describe);
    checklist.push({ label: "Camera responded to the stream request", pass: describeOk });
    if (!describeOk) {
      diagnostics.push(describe.split("\r\n")[0] ?? "no status line");
      const reason = authAttempted ? "The camera rejected the stream request." : "The stream path may be wrong, or RTSP may be disabled for this stream.";
      return { ok: false, checklist, reason, diagnostics, codec: null };
    }

    const sdpStart = describe.indexOf("\r\n\r\n");
    const sdp = sdpStart >= 0 ? describe.slice(sdpStart + 4) : "";
    const hasVideoMedia = /^m=video/im.test(sdp);
    checklist.push({ label: "Video stream is available", pass: hasVideoMedia });
    const codecMatch = sdp.match(/a=rtpmap:\d+\s+([\w-]+)\//i);
    const codec = codecMatch ? codecMatch[1]!.toUpperCase() : null;

    if (!hasVideoMedia) {
      return { ok: false, checklist, reason: "The camera responded, but no video stream was advertised.", diagnostics, codec };
    }

    return { ok: true, checklist, reason: null, diagnostics, codec };
  } catch (err) {
    diagnostics.push(err instanceof Error ? err.message : String(err));
    checklist.push({ label: "Stream validation completed", pass: false });
    return { ok: false, checklist, reason: "The camera stopped responding during validation.", diagnostics, codec: null };
  } finally {
    sock.close();
  }
}
