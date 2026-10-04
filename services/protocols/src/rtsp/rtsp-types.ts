/**
 * RTSP Camera driver — shared types (§ RTSP Camera Extension).
 *
 * A "discovery result" is a candidate camera found on the LAN, before any credential has been
 * supplied. It NEVER carries a password/username — see the discovery result model in the spec
 * (STEP 5): only identity/network facts a passive scan can observe. Real commissioning
 * (credentials, stream retrieval, validation) is a separate, later step — see rtsp-camera-service.ts.
 */

export type DiscoveryMethod = "onvif" | "rtsp-probe";

export interface RtspDiscoveryResult {
  /** Stable id for this discovery result within one discovery session — NOT a persisted Supreme
   * device id. Built from the strongest identity signal available (see rtsp-identity.ts). */
  id: string;
  discoveryMethod: DiscoveryMethod;
  /** Every method that independently found this same physical camera (§ Dedup — a camera found
   * via ONVIF AND a bare RTSP-port probe merges into one result with both methods listed). */
  discoveryMethods: DiscoveryMethod[];
  ipAddress: string;
  port: number;
  name: string;
  manufacturer: string | null;
  model: string | null;
  hostname: string | null;
  onvifUuid: string | null;
  onvifEndpoint: string | null;
  rtspAvailable: boolean;
  onvifAvailable: boolean;
  /** Additional RTSP ports found responsive during fallback probing, when more than one. */
  rtspPorts: number[];
  /** True when the host answered on a UniFi Protect console port (7441/7447). That identifies the
   * console, not a camera — `rtspAvailable` stays false unless a real RTSP port also answered.
   * Optional so older producers/consumers stay compatible. */
  unifiProtectConsole?: boolean;
}

/** One ONVIF WS-Discovery ProbeMatch, already decoded from its SOAP envelope — everything is
 * optional/nullable except the endpoint, since a partial/legacy ONVIF stack may omit any field
 * (§ STEP 3 — "handle any missing field gracefully"). */
export interface OnvifProbeMatch {
  /** The device's stable ONVIF UUID (from the `EndpointReference` address,
   * `urn:uuid:...` stripped to the bare UUID). */
  uuid: string | null;
  /** XAddrs — one or more device-service endpoint URLs (http://ip:port/onvif/device_service). */
  xaddrs: string[];
  /** Scopes list, raw (e.g. `onvif://www.onvif.org/name/FrontDoor`,
   * `onvif://www.onvif.org/hardware/DS-2CD...`). */
  scopes: string[];
  /** Space-separated `dn:NetworkVideoTransmitter dp:...` type list, when present. */
  types: string[];
}

export interface OnvifDeviceInfo {
  manufacturer: string | null;
  model: string | null;
  firmwareVersion: string | null;
  serialNumber: string | null;
  hardwareId: string | null;
}

export interface OnvifMediaProfile {
  token: string;
  name: string | null;
  /** True when this looks like the primary/high-resolution profile (first one returned, or one
   * whose name/token hints "main"/"stream1") — a heuristic only, never fabricated resolution data
   * ONVIF didn't actually report. */
  isLikelyMain: boolean;
}

export interface RtspStreamCheck {
  ok: boolean;
  /** Plain-English, installer-facing checklist (§ STEP 8) — technical detail never leaks here. */
  checklist: { label: string; pass: boolean }[];
  /** One plain-English cause when `ok` is false; null when ok or when validation could not even
   * start (e.g. invalid URL — checklist explains that case instead). */
  reason: string | null;
  /** Technical diagnostics — installer-facing only inside a "Diagnostics" affordance, never the
   * primary error text (§ STEP 8). */
  diagnostics: string[];
  codec: string | null;
}
