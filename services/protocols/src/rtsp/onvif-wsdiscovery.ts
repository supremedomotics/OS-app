import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import type { OnvifProbeMatch } from "./rtsp-types.js";

/**
 * ONVIF WS-Discovery (§ STEP 3, primary discovery mechanism). WS-Discovery is SOAP-over-UDP
 * multicast to 239.255.255.250:3702 (ONVIF Core Spec §7 / WS-Discovery 1.1) — a real, standard
 * protocol, not simulated. This module is split the same way every other discovery mechanism in
 * this fleet is (`mdns.ts`, `devialet-discovery.ts`): pure envelope encode/decode here, real
 * sockets in {@link probeOnvif}, injectable for tests.
 */
export const WS_DISCOVERY_MULTICAST_ADDRESS = "239.255.255.250";
export const WS_DISCOVERY_PORT = 3702;

/** A real WS-Discovery Probe message targeting NetworkVideoTransmitter devices (the ONVIF Profile
 * S device type) — narrower than a bare Probe, so non-camera ONVIF services (if any) don't
 * pollute results, while still degrading gracefully: a device that only answers a scope-less
 * Probe is picked up by {@link parseProbeMatch} regardless, since not every partial ONVIF stack
 * honors the type filter. */
export function buildProbeMessage(messageId = randomUUID()): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ` +
    `xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ` +
    `xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ` +
    `xmlns:dn="http://www.onvif.org/ver10/network/wsdl">` +
    `<e:Header>` +
    `<w:MessageID>urn:uuid:${messageId}</w:MessageID>` +
    `<w:To e:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
    `<w:Action e:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>` +
    `</e:Header>` +
    `<e:Body>` +
    `<d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>` +
    `</e:Body>` +
    `</e:Envelope>`
  );
}

/** Extracts the first match of a namespace-agnostic tag from raw XML/SOAP text — a tolerant,
 * regex-based reader (same pragmatic approach `coolmaster-parser.ts`/`mdns.ts` use for
 * hand-rolled wire text in this codebase; no XML dependency added for one field-extraction need).
 * Handles an arbitrary namespace prefix (`<d:Types>`, `<tns:Types>`, unprefixed `<Types>`) and
 * self-closing/empty elements gracefully (returns null, never throws). */
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1]!.trim() : null;
}

function extractAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]!.trim());
  return out;
}

/**
 * Parses one WS-Discovery ProbeMatch SOAP envelope. Returns `null` for anything that isn't a
 * ProbeMatch at all (a Hello/Bye, or unrelated multicast traffic sharing the port) — malformed or
 * partial XML inside an actual ProbeMatch degrades field-by-field instead (§ STEP 3/12 — "handle
 * any missing field gracefully" / "malformed ONVIF XML" must never crash discovery).
 */
export function parseProbeMatch(xml: string): OnvifProbeMatch | null {
  if (!/ProbeMatch(es)?\b/i.test(xml)) return null;
  try {
    const addr = extractTag(xml, "Address");
    const uuidMatch = addr?.match(/urn:uuid:([0-9a-fA-F-]{36})/);
    const xaddrsRaw = extractTag(xml, "XAddrs") ?? "";
    const xaddrs = xaddrsRaw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    const scopesRaw = extractTag(xml, "Scopes") ?? "";
    const scopes = scopesRaw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    const typesRaw = extractTag(xml, "Types") ?? "";
    const types = typesRaw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (xaddrs.length === 0) return null; // no usable device-service endpoint at all
    return { uuid: uuidMatch ? uuidMatch[1]!.toLowerCase() : null, xaddrs, scopes, types };
  } catch {
    return null; // malformed XML — never crash discovery for one bad responder (§ STEP 12)
  }
}

/** Reads a `onvif://www.onvif.org/<key>/<value...>` scope entry's value, if present. ONVIF scopes
 * are informal (a manufacturer may URL-encode or omit a scope entirely), so this is a
 * best-effort read, never assumed present. */
export function scopeValue(scopes: string[], key: string): string | null {
  const prefix = `onvif://www.onvif.org/${key}/`;
  const hit = scopes.find((s) => s.toLowerCase().startsWith(prefix));
  if (!hit) return null;
  try {
    return decodeURIComponent(hit.slice(prefix.length)).replace(/\+/g, " ").trim() || null;
  } catch {
    return hit.slice(prefix.length).trim() || null;
  }
}

export interface OnvifDiscoverySocket {
  send(data: Buffer): void;
  onMessage(cb: (msg: Buffer, rinfo: { address: string }) => void): void;
  close(): void;
}

/** Real UDP multicast socket bound on one local interface, joined to the WS-Discovery group.
 * Injectable (`socketFactory`) so tests never touch a real network. */
function realSocket(localAddress: string): Promise<OnvifDiscoverySocket> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const onError = (err: Error) => reject(err);
    sock.once("error", onError);
    sock.bind({ address: localAddress, port: 0 }, () => {
      sock.removeListener("error", onError);
      try {
        sock.setMulticastTTL(4);
        sock.setMulticastInterface(localAddress);
      } catch {
        // Some platforms/interfaces reject setMulticastInterface — probing still works via the
        // default route; never fatal to discovery (§ STEP 12).
      }
      resolve({
        send(data) {
          try {
            sock.send(data, WS_DISCOVERY_PORT, WS_DISCOVERY_MULTICAST_ADDRESS);
          } catch {
            // A send failure on one interface (e.g. it went down mid-scan) must not crash
            // discovery on the others (§ STEP 12 — network interface changes).
          }
        },
        onMessage(cb) {
          sock.on("message", (msg, rinfo) => cb(msg, { address: rinfo.address }));
        },
        close() {
          try {
            sock.close();
          } catch {
            /* already closed */
          }
        },
      });
    });
    sock.once("error", (err) => reject(err));
  });
}

export interface ProbeOnvifOptions {
  /** Local IPv4 addresses to probe FROM — one multicast probe is sent per interface (§ STEP 3 —
   * "discovery across multiple local IPv4 network interfaces"). */
  interfaces: string[];
  timeoutMs?: number;
  /** Injectable socket factory (tests only) — default opens a real multicast UDP socket. */
  socketFactory?: (localAddress: string) => Promise<OnvifDiscoverySocket>;
  /** `fromAddress` is the UDP responder's real source address (`rinfo.address`) — the fallback
   * used when a ProbeMatch's XAddr can't be parsed (§ FINDING 6). It is NOT the local interface
   * address the probe was sent from; using the local interface here would misidentify a camera
   * with a malformed XAddr as the hub itself. */
  onMatch?: (match: OnvifProbeMatch, fromAddress: string) => void;
  /** AbortSignal — cancels the probe early, returning whatever was found so far (§ STEP 13). */
  signal?: AbortSignal;
}

/**
 * Sends a WS-Discovery Probe on every given interface and collects ProbeMatch responses for
 * `timeoutMs`. Never throws for one bad interface/socket (§ STEP 12) — a failure on one interface
 * is logged into the returned `errors` list and every other interface still probes normally.
 */
export async function probeOnvif(opts: ProbeOnvifOptions): Promise<{ matches: OnvifProbeMatch[]; errors: string[] }> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const factory = opts.socketFactory ?? realSocket;
  const matches: OnvifProbeMatch[] = [];
  const errors: string[] = [];
  const sockets: OnvifDiscoverySocket[] = [];

  await Promise.all(
    opts.interfaces.map(async (iface) => {
      try {
        const sock = await factory(iface);
        sockets.push(sock);
        sock.onMessage((msg, rinfo) => {
          const match = parseProbeMatch(msg.toString("utf8"));
          if (match) {
            matches.push(match);
            // § FINDING 6 — the responder's real UDP source address, not the local interface we
            // sent the probe from; resolveOnvifAddress() falls back to this only when the
            // ProbeMatch's own XAddr is unparseable.
            opts.onMatch?.(match, rinfo.address);
          }
        });
        sock.send(Buffer.from(buildProbeMessage(), "utf8"));
      } catch (err) {
        errors.push(`${iface}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  await new Promise<void>((resolve) => {
    if (opts.signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    opts.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  for (const sock of sockets) sock.close();
  return { matches, errors };
}
