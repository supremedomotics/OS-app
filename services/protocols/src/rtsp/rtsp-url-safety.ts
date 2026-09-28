import net from "node:net";
import dns from "node:dns";

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
  /** The address actually validated/connected to — for a hostname this is the resolved IP, since
   * a DNS record can point anywhere and the resolved address, not the literal string, is what a
   * real network call ever reaches (§ STEP 11 — DNS rebinding / SSRF via manual hostname). */
  resolvedAddress: string | null;
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

/** Validates scheme + host, then — for a bare hostname (e.g. `camera.local`) — resolves it and
 * checks the RESOLVED address, not just the literal string (§ STEP 11: `net.isIP()` returns 0 for
 * any hostname, so a manual URL like `rtsp://attacker.example:554/stream` must never be let
 * through on the string alone — a DNS record can point anywhere, and only the resolved address is
 * what a real network call ever reaches). Rejects: non-`rtsp:` schemes (blocks `file://`,
 * `http://` SSRF-to-cloud tricks, and `rtsps:` — see the scheme check below), a public/
 * internet-routable host or resolved address (discovery is local-network scoped only), a
 * hostname that fails to resolve at all, and a malformed URL. */
export async function validateRtspUrl(raw: string): Promise<RtspUrlValidation> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL.", host: null, port: 0, resolvedAddress: null };
  }
  if (url.protocol === "rtsps:") {
    // § FINDING 4 — the only transport this driver implements is a plain unencrypted net.Socket
    // (rtsp-handshake.ts); accepting rtsps: here would silently drop straight to plaintext instead
    // of the TLS the installer's URL asked for. Reject cleanly rather than half-implementing TLS.
    return { ok: false, reason: "rtsps:// (RTSP over TLS) is not supported by this driver yet — use rtsp:// instead.", host: null, port: 0, resolvedAddress: null };
  }
  if (url.protocol !== "rtsp:") {
    return { ok: false, reason: "Only rtsp:// URLs are allowed.", host: null, port: 0, resolvedAddress: null };
  }
  const rawHost = url.hostname;
  if (!rawHost) return { ok: false, reason: "URL has no host.", host: null, port: 0, resolvedAddress: null };
  const host = rawHost.replace(/^\[|\]$/g, "");
  if (net.isIP(host) === 6) {
    return { ok: false, reason: "IPv6 camera addresses are not yet supported.", host, port: 0, resolvedAddress: null };
  }
  const port = url.port ? Number(url.port) : 554;

  if (net.isIP(host) === 4) {
    if (!isPrivateOrLoopbackV4(host) && host !== "0.0.0.0") {
      return { ok: false, reason: "Only local-network camera addresses are allowed.", host, port, resolvedAddress: null };
    }
    return { ok: true, reason: null, host, port, resolvedAddress: host };
  }

  // A bare hostname — resolve it and validate the ACTUAL address before permitting the connection.
  let resolved: string;
  try {
    const { address } = await dns.promises.lookup(host, { family: 4 });
    resolved = address;
  } catch {
    return { ok: false, reason: "The camera hostname could not be resolved.", host, port, resolvedAddress: null };
  }
  if (!isPrivateOrLoopbackV4(resolved) && resolved !== "0.0.0.0") {
    return { ok: false, reason: "Only local-network camera addresses are allowed.", host, port, resolvedAddress: resolved };
  }
  return { ok: true, reason: null, host, port, resolvedAddress: resolved };
}

/**
 * § FINDING 3 — the same local-network-only SSRF guard, applied to an installer-supplied ONVIF
 * endpoint URL (an arbitrary `http(s)://` address) before it is ever handed to the ONVIF SOAP
 * client's real `fetch`. Unlike {@link validateRtspUrl} this accepts `http:`/`https:` schemes
 * (ONVIF device services are plain HTTP SOAP endpoints) but applies the identical host/DNS
 * resolution check — a public or unresolvable host is rejected the same way.
 */
export async function validateOnvifEndpointUrl(raw: string): Promise<RtspUrlValidation> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "The ONVIF endpoint is not a valid URL.", host: null, port: 0, resolvedAddress: null };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http:// or https:// ONVIF endpoints are allowed.", host: null, port: 0, resolvedAddress: null };
  }
  const rawHost = url.hostname;
  if (!rawHost) return { ok: false, reason: "ONVIF endpoint URL has no host.", host: null, port: 0, resolvedAddress: null };
  const host = rawHost.replace(/^\[|\]$/g, "");
  if (net.isIP(host) === 6) {
    return { ok: false, reason: "IPv6 ONVIF endpoints are not yet supported.", host, port: 0, resolvedAddress: null };
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

  if (net.isIP(host) === 4) {
    if (!isPrivateOrLoopbackV4(host) && host !== "0.0.0.0") {
      return { ok: false, reason: "Only local-network ONVIF endpoints are allowed.", host, port, resolvedAddress: null };
    }
    return { ok: true, reason: null, host, port, resolvedAddress: host };
  }

  let resolved: string;
  try {
    const { address } = await dns.promises.lookup(host, { family: 4 });
    resolved = address;
  } catch {
    return { ok: false, reason: "The ONVIF endpoint hostname could not be resolved.", host, port, resolvedAddress: null };
  }
  if (!isPrivateOrLoopbackV4(resolved) && resolved !== "0.0.0.0") {
    return { ok: false, reason: "Only local-network ONVIF endpoints are allowed.", host, port, resolvedAddress: resolved };
  }
  return { ok: true, reason: null, host, port, resolvedAddress: resolved };
}
