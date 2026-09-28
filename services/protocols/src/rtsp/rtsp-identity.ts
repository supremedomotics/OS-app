import type { DiscoveryMethod, OnvifProbeMatch, RtspDiscoveryResult } from "./rtsp-types.js";
import { scopeValue } from "./onvif-wsdiscovery.js";

/** One raw discovery signal, before merge — an ONVIF ProbeMatch resolved to an address, or a bare
 * RTSP-port hit. `rtsp-camera-service.ts` builds these; this module turns them into deduplicated,
 * well-named {@link RtspDiscoveryResult}s. Kept separate from I/O so identity/naming/dedup — the
 * part STEP 4/6's acceptance criteria actually hinge on — is fully unit-testable with no sockets.
 */
export interface RawOnvifSignal {
  method: "onvif";
  ipAddress: string;
  port: number;
  match: OnvifProbeMatch;
  hostname?: string | null;
}
export interface RawRtspSignal {
  method: "rtsp-probe";
  ipAddress: string;
  ports: number[];
  hostname?: string | null;
}
export type RawSignal = RawOnvifSignal | RawRtspSignal;

/** § STEP 4 — best-available-name priority. Never falls back past what's actually known; the last
 * resort (bare IP) is the only guaranteed-non-null option, matching "never just Camera <ip> when
 * better info exists." */
export function bestName(input: {
  onvifName?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  mdnsOrSsdpName?: string | null;
  hostname?: string | null;
  ipAddress: string;
}): string {
  if (input.onvifName?.trim()) return input.onvifName.trim();
  if (input.manufacturer?.trim() && input.model?.trim()) return `${input.manufacturer.trim()} ${input.model.trim()}`;
  if (input.mdnsOrSsdpName?.trim()) return input.mdnsOrSsdpName.trim();
  if (input.hostname?.trim()) return input.hostname.trim();
  if (input.manufacturer?.trim()) return input.manufacturer.trim();
  if (input.model?.trim()) return input.model.trim();
  return input.ipAddress;
}

/** Resolves an ONVIF ProbeMatch's `xaddrs[0]` into `{ipAddress, port}` — the device-service URL is
 * the only network-address signal WS-Discovery itself carries (the UDP source address can be a
 * relay/NAT hop, e.g. a multi-homed NVR proxying discovery for its channels, so the XAddr host is
 * the more trustworthy one whenever it parses). Falls back to the observed UDP source address if
 * the XAddr URL is unparseable (§ STEP 12 — malformed field). */
export function resolveOnvifAddress(match: OnvifProbeMatch, sourceAddress: string): { ipAddress: string; port: number } {
  try {
    const url = new URL(match.xaddrs[0]!);
    return { ipAddress: url.hostname, port: url.port ? Number(url.port) : 80 };
  } catch {
    return { ipAddress: sourceAddress, port: 80 };
  }
}

/** Identity key for dedup (§ STEP 6 priority: ONVIF UUID -> device UUID -> MAC ->
 * manufacturer+model+IP -> IP+service fingerprint). This driver never has a MAC-layer view (pure
 * IP discovery), so that tier is skipped honestly rather than fabricated; the remaining tiers are
 * exactly what real signals here support. */
function identityKey(r: {
  onvifUuid: string | null;
  manufacturer: string | null;
  model: string | null;
  ipAddress: string;
  onvifAvailable: boolean;
  rtspAvailable: boolean;
}): string {
  if (r.onvifUuid) return `uuid:${r.onvifUuid}`;
  if (r.manufacturer && r.model) return `mm:${r.manufacturer.toLowerCase()}:${r.model.toLowerCase()}:${r.ipAddress}`;
  return `ipfp:${r.ipAddress}:${r.onvifAvailable ? "o" : ""}${r.rtspAvailable ? "r" : ""}`;
}

/** Builds ONE deduplicated, best-named {@link RtspDiscoveryResult} per real camera from every raw
 * signal collected this discovery session (§ STEP 4/5/6). Never crashes on a partial/malformed
 * signal — each is folded independently. */
export function mergeSignals(signals: RawSignal[]): RtspDiscoveryResult[] {
  const byKey = new Map<string, RtspDiscoveryResult & { _mdns?: string | null }>();

  for (const sig of signals) {
    if (sig.method === "onvif") {
      const manufacturer = scopeValue(sig.match.scopes, "hardware") ? null : scopeValue(sig.match.scopes, "manufacturer");
      const model = scopeValue(sig.match.scopes, "hardware");
      const onvifName = scopeValue(sig.match.scopes, "name");
      const key = identityKey({
        onvifUuid: sig.match.uuid,
        manufacturer,
        model,
        ipAddress: sig.ipAddress,
        onvifAvailable: true,
        rtspAvailable: false,
      });
      const existing = byKey.get(key);
      const name = bestName({ onvifName, manufacturer, model, hostname: sig.hostname, ipAddress: sig.ipAddress });
      if (existing) {
        existing.onvifAvailable = true;
        existing.onvifEndpoint = existing.onvifEndpoint ?? sig.match.xaddrs[0] ?? null;
        existing.onvifUuid = existing.onvifUuid ?? sig.match.uuid;
        existing.manufacturer = existing.manufacturer ?? manufacturer;
        existing.model = existing.model ?? model;
        existing.hostname = existing.hostname ?? sig.hostname ?? null;
        if (!existing.discoveryMethods.includes("onvif")) existing.discoveryMethods.push("onvif");
        // A real ONVIF name always outranks whatever name a bare RTSP probe guessed earlier.
        if (onvifName) existing.name = name;
      } else {
        byKey.set(key, {
          id: key,
          discoveryMethod: "onvif",
          discoveryMethods: ["onvif"],
          ipAddress: sig.ipAddress,
          port: sig.port,
          name,
          manufacturer,
          model,
          hostname: sig.hostname ?? null,
          onvifUuid: sig.match.uuid,
          onvifEndpoint: sig.match.xaddrs[0] ?? null,
          rtspAvailable: false,
          onvifAvailable: true,
          rtspPorts: [],
        });
      }
    } else {
      const key = identityKey({
        onvifUuid: null,
        manufacturer: null,
        model: null,
        ipAddress: sig.ipAddress,
        onvifAvailable: false,
        rtspAvailable: true,
      });
      // A bare RTSP hit merges into an existing ONVIF result at the SAME ip:port fingerprint key
      // too — the ONVIF-keyed entry above didn't use the `ipfp` key, so look it up explicitly.
      const onvifSibling = [...byKey.values()].find((v) => v.ipAddress === sig.ipAddress && v.onvifAvailable);
      const existing = onvifSibling ?? byKey.get(key);
      if (existing) {
        existing.rtspAvailable = true;
        existing.rtspPorts = Array.from(new Set([...existing.rtspPorts, ...sig.ports]));
        existing.hostname = existing.hostname ?? sig.hostname ?? null;
        if (!existing.discoveryMethods.includes("rtsp-probe")) existing.discoveryMethods.push("rtsp-probe");
      } else {
        byKey.set(key, {
          id: key,
          discoveryMethod: "rtsp-probe",
          discoveryMethods: ["rtsp-probe"],
          ipAddress: sig.ipAddress,
          port: sig.ports[0] ?? 554,
          name: bestName({ hostname: sig.hostname, ipAddress: sig.ipAddress }),
          manufacturer: null,
          model: null,
          hostname: sig.hostname ?? null,
          onvifUuid: null,
          onvifEndpoint: null,
          rtspAvailable: true,
          onvifAvailable: false,
          rtspPorts: [...sig.ports],
        });
      }
    }
  }

  return [...byKey.values()]
    .map(({ _mdns, ...r }) => r)
    .sort((a, b) => a.ipAddress.localeCompare(b.ipAddress, undefined, { numeric: true }));
}

export function methodLabel(m: DiscoveryMethod): string {
  return m === "onvif" ? "ONVIF" : "RTSP probe";
}
