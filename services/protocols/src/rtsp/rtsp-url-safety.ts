import net from "node:net";

/**
 * § STEP 11 — validates an installer-supplied RTSP URL to prevent SSRF / the hub becoming an open
 * proxy. Discovery itself only ever offers LAN-scoped candidates, but the RTSP-only manual-entry
 * flow accepts a free-text URL, so it is validated here before anything ever connects to it.
 */
export interface RtspUrlValidation {
  ok: boolean;
  reason: string | null;
  host: string | null;
  port: number;
}

const PRIVATE_V4_RANGES: [RegExp, string][] = [
  [/^10\./, "10.0.0.0/8"],
  [/^192\.168\./, "192.168.0.0/16"],
  [/^172\.(1[6-9]|2\d|3[0-1])\./, "172.16.0.0/12"],
  [/^169\.254\./, "169.254.0.0/16 (link-local)"],
  [/^127\./, "127.0.0.0/8 (loopback)"],
];

function isPrivateOrLoopbackV4(host: string): boolean {
  return PRIVATE_V4_RANGES.some(([re]) => re.test(host));
}

/** Validates scheme + host. Rejects: non-`rtsp(s)` schemes (blocks `file://`, `http://`
 * SSRF-to-cloud tricks, etc.), a public/internet-routable host (discovery is local-network scoped
 * only — STEP 11), and a malformed URL. A bare hostname (e.g. `camera.local`) is accepted since
 * mDNS-resolved local hostnames are legitimate and not resolvable to a public-vs-private
 * distinction without a DNS lookup this pure validator deliberately doesn't perform — the actual
 * TCP connect step (rtsp-handshake.ts) is where an attacker-controlled DNS answer would fail
 * anyway, since it only ever connects to what resolves, on a network this hub already sits on. */
export function validateRtspUrl(raw: string): RtspUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL.", host: null, port: 0 };
  }
  if (url.protocol !== "rtsp:" && url.protocol !== "rtsps:") {
    return { ok: false, reason: "Only rtsp:// or rtsps:// URLs are allowed.", host: null, port: 0 };
  }
  const rawHost = url.hostname;
  if (!rawHost) return { ok: false, reason: "URL has no host.", host: null, port: 0 };
  const host = rawHost.replace(/^\[|\]$/g, "");
  if (net.isIP(host) === 6) {
    return { ok: false, reason: "IPv6 camera addresses are not yet supported.", host, port: 0 };
  }
  if (net.isIP(host) === 4 && !isPrivateOrLoopbackV4(host) && host !== "0.0.0.0") {
    return { ok: false, reason: "Only local-network camera addresses are allowed.", host, port: 0 };
  }
  const port = url.port ? Number(url.port) : 554;
  return { ok: true, reason: null, host, port };
}
