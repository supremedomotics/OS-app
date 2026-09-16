import type { MdnsService } from "./mdns.js";

/**
 * Devialet mDNS discovery — pure parsing/filtering only (§ D5). No I/O lives here
 * (mirrors the `*-codec.ts` split elsewhere in this fleet: pure transformation,
 * separate from the network calls in `devialet-driver.ts`). Every rule below is taken
 * directly from the R1 doc's own "Discovery" section, including its worked
 * `avahi-browse` example — which itself shows the SAME physical device advertising
 * FOUR service instances (IPv4 + IPv6, each with a plain `_http._tcp` "Living room"
 * entry and a real "Living room-ipcontrol" entry) — the concrete reason multiple mDNS
 * records for one device is a real, doc-evidenced case, not a hypothetical.
 */

/** The correct Bonjour service type per the R1 doc — Devialet devices register
 * instances under `_http._tcp`, filtered by TXT content. `_devialet-http._tcp` (the
 * pre-D5 constant) does not appear anywhere in the R1 documentation. */
export const DEVIALET_MDNS_SERVICE = "_http._tcp.local";

/**
 * A `_http._tcp` mDNS service instance that has passed TXT filtering — a candidate
 * transport endpoint that MAY be a real Devialet R1 device, not yet confirmed (§8/§9
 * — "DISCOVERED TRANSPORT" vs. "IDENTIFIED DEVIALET DEVICE": confirming this requires
 * a real `/devices/current` query, which is I/O and therefore lives in the driver,
 * not here).
 */
export interface DevialetDiscoveryCandidate {
  /** mDNS instance name, e.g. "Living room-ipcontrol._http._tcp.local" — used only
   * for a best-effort fallback display name and log/trace messages, never identity. */
  mdnsName: string;
  /** Resolved address (IPv4 or IPv6 — the doc explicitly does not guarantee which:
   * "the address entries may be in either IPv4 or IPv6 format"). Transport
   * information only. */
  host: string;
  port: number;
  /** From the TXT `path` key — REQUIRED for a valid candidate (§4: a candidate
   * missing `path` is filtered out by `parseDevialetCandidate`, never defaulted). */
  path: string;
  /** From the TXT `ipControlVersion` key, preserved verbatim (not parsed as a
   * number — the doc shows it as `"1"`, a string, and does not promise it stays
   * numeric-looking forever). Available to future capability logic (§16); D5 does
   * not branch on its value beyond requiring it be present. */
  ipControlVersion: string;
  manufacturer: string;
}

/**
 * Filters + parses ONE mDNS service instance into a `DevialetDiscoveryCandidate`, or
 * `null` if it isn't a valid, complete Devialet R1 candidate. Every rejection reason
 * is a real, documented requirement:
 * - `manufacturer` TXT key must be exactly `"Devialet"` (doc: "it has to contain...
 *   'manufacturer=Devialet'") — never inferred from hostname (the doc explicitly
 *   warns against filtering on the `hostname` parameter) or port.
 * - `ipControlVersion` TXT key must be present (doc: "...and 'ipControlVersion=1'").
 *   Its value is not further validated here — §16, capability logic is later work —
 *   but an ABSENT key means "do not blindly assume R1 compatibility" (§4), so such a
 *   record is rejected outright, not retained as a partial/degraded candidate.
 * - `path` TXT key must be present and non-empty — required to build any real R1
 *   request; never defaulted to `/ipcontrol/v1` or any other literal here (that
 *   interim fallback exists only in `devialet-driver.ts`'s OWN `bind()`-time default
 *   for a MANUALLY-added device with no discovery record at all — a genuinely
 *   different case from a discovered-but-incomplete mDNS record).
 * - `port` must be a finite, positive number — a malformed/zero/negative port from a
 *   malfunctioning responder is rejected rather than trusted.
 * - at least one resolved address must be present.
 */
export function parseDevialetCandidate(service: MdnsService): DevialetDiscoveryCandidate | null {
  const manufacturer = service.txt.manufacturer;
  if (manufacturer !== "Devialet") return null;
  const ipControlVersion = service.txt.ipControlVersion;
  if (!ipControlVersion) return null;
  const path = service.txt.path;
  if (!path) return null;
  if (!Number.isFinite(service.port) || service.port <= 0) return null;
  const host = service.addresses[0];
  if (!host) return null;
  return { mdnsName: service.name, host, port: service.port, path, ipControlVersion, manufacturer };
}

/**
 * Builds the transport host string `DevialetIpControlClient`/`DevialetCiSettingsClient`
 * expect — `host:port`, so a non-default port is never silently dropped. Handles the
 * doc's own IPv6-address caveat by wrapping a literal IPv6 address in brackets before
 * appending the port (`[::1]:8080`), the standard URL-authority form; an address that
 * already looks bracketed or is a hostname/IPv4 literal is left as-is.
 */
export function transportHostFor(candidate: DevialetDiscoveryCandidate): string {
  const isBareIpv6 = candidate.host.includes(":") && !candidate.host.startsWith("[");
  const hostPart = isBareIpv6 ? `[${candidate.host}]` : candidate.host;
  return `${hostPart}:${candidate.port}`;
}
