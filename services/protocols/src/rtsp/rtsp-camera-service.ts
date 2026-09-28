import { probeOnvif, type ProbeOnvifOptions } from "./onvif-wsdiscovery.js";
import { probeRtspPorts, DEFAULT_RTSP_PORTS, type TcpProbe } from "./rtsp-port-probe.js";
import { localIPv4Interfaces, subnetHosts } from "./network-interfaces.js";
import { mergeSignals, resolveOnvifAddress, type RawSignal } from "./rtsp-identity.js";
import { getDeviceInformation, getMediaServiceEndpoint, getMediaProfiles, getStreamUri, type SoapFetch, OnvifSoapError } from "./onvif-soap.js";
import { validateRtspStream, type RtspSocketFactory } from "./rtsp-handshake.js";
import { validateRtspUrl } from "./rtsp-url-safety.js";
import type { RtspDiscoveryResult, RtspStreamCheck } from "./rtsp-types.js";

/**
 * RTSP Camera driver — top-level orchestration (§ Extension Center: Install -> Discover Devices ->
 * Select -> Configure -> Commission -> Persist -> Verify). This module owns discovery,
 * identification and commissioning ONLY (§ STEP 9) — persistence into a Supreme camera device and
 * streaming stay entirely the existing `@supreme/cameras`/`CameraService`/`StreamGateway`
 * pipeline; the gateway route layer is what actually calls `CameraService.register` with this
 * module's output.
 */

export interface DiscoverCamerasOptions {
  timeoutMs?: number;
  /** Real RTSP fallback probe runs across each interface's own /24 by default; a caller (test, or
   * an installer-tuned scan) may narrow this. */
  hostsOverride?: string[];
  ports?: number[];
  concurrency?: number;
  signal?: AbortSignal;
  onResult?: (partial: RtspDiscoveryResult[]) => void;
  // Injectable I/O (tests only) — real network by default.
  interfaces?: string[];
  onvifSocketFactory?: ProbeOnvifOptions["socketFactory"];
  tcpProbe?: TcpProbe;
}

/**
 * Runs ONVIF WS-Discovery + the RTSP fallback probe together across every local interface,
 * streaming incremental results via `onResult` (§ STEP 13 — never blocks the UI until every
 * timeout expires) and returning the final, deduplicated list.
 */
export async function discoverCameras(opts: DiscoverCamerasOptions = {}): Promise<RtspDiscoveryResult[]> {
  const interfaces = opts.interfaces ?? localIPv4Interfaces();
  const signals: RawSignal[] = [];

  const publish = () => opts.onResult?.(mergeSignals(signals));

  const onvifPromise =
    interfaces.length > 0
      ? probeOnvif({
          interfaces,
          timeoutMs: opts.timeoutMs ?? 3000,
          socketFactory: opts.onvifSocketFactory,
          signal: opts.signal,
          onMatch: (match, fromAddress) => {
            const { ipAddress, port } = resolveOnvifAddress(match, fromAddress);
            signals.push({ method: "onvif", ipAddress, port, match });
            publish();
          },
        })
      : Promise.resolve({ matches: [], errors: [] });

  const hosts = opts.hostsOverride ?? interfaces.flatMap((i) => subnetHosts(i));
  const rtspPromise =
    hosts.length > 0
      ? probeRtspPorts({
          hosts,
          ports: opts.ports ?? DEFAULT_RTSP_PORTS,
          concurrency: opts.concurrency ?? 32,
          timeoutMs: 400,
          signal: opts.signal,
          probe: opts.tcpProbe,
          onHit: (host, port) => {
            // Skip a host already carrying a fresh ONVIF signal from THIS session, so the
            // incremental stream doesn't flash a duplicate row before merge finalizes it — merge
            // still reconciles this correctly even if publish() races ahead of an onvif match.
            const existingPorts = (signals.find((s) => s.method === "rtsp-probe" && s.ipAddress === host) as
              | { method: "rtsp-probe"; ports: number[] }
              | undefined)?.ports;
            if (existingPorts) {
              if (!existingPorts.includes(port)) existingPorts.push(port);
            } else {
              signals.push({ method: "rtsp-probe", ipAddress: host, ports: [port] });
            }
            publish();
          },
        })
      : Promise.resolve(new Map<string, number[]>());

  await Promise.all([onvifPromise, rtspPromise]);
  return mergeSignals(signals);
}

// ── Commissioning ────────────────────────────────────────────────────────────────

export interface CommissionCredentials {
  username: string;
  password: string;
}

export interface OnvifStreamInfo {
  manufacturer: string | null;
  model: string | null;
  mainStreamUri: string | null;
  subStreamUri: string | null;
  mainProfileToken: string | null;
  subProfileToken: string | null;
}

export interface OnvifCommissionOptions {
  deviceEndpoint: string;
  credentials: CommissionCredentials;
  fetchImpl?: SoapFetch;
}

/**
 * § STEP 7 — ONVIF flow: authenticate, query device info, query media profiles, retrieve the RTSP
 * URI for the main stream and (when a second profile exists) a substream. Real SOAP calls, never
 * a vendor-URL guess. Throws a `CommissioningError` with an installer-safe message on any failure
 * (auth, no profiles, transport) — the gateway route maps this straight to the API response.
 */
export async function getOnvifStreamInfo(opts: OnvifCommissionOptions): Promise<OnvifStreamInfo> {
  const fetchImpl = opts.fetchImpl;
  let info: { manufacturer: string | null; model: string | null };
  try {
    info = await getDeviceInformation(opts.deviceEndpoint, opts.credentials, fetchImpl);
  } catch (err) {
    if (err instanceof OnvifSoapError && /authentication/i.test(err.message)) {
      throw new CommissioningError("The username or password was rejected by the camera.");
    }
    // Some partial ONVIF stacks reject GetDeviceInformation but still serve media — proceed with
    // unknown manufacturer/model rather than failing commissioning outright (§ STEP 12).
    info = { manufacturer: null, model: null };
  }

  let mediaEndpoint: string;
  try {
    mediaEndpoint = await getMediaServiceEndpoint(opts.deviceEndpoint, opts.credentials, fetchImpl);
  } catch {
    mediaEndpoint = opts.deviceEndpoint.replace(/device_service/i, "media_service");
  }

  let profiles: Awaited<ReturnType<typeof getMediaProfiles>>;
  try {
    profiles = await getMediaProfiles(mediaEndpoint, opts.credentials, fetchImpl);
  } catch (err) {
    if (err instanceof OnvifSoapError && /authentication/i.test(err.message)) {
      throw new CommissioningError("The username or password was rejected by the camera.");
    }
    throw new CommissioningError("The camera could not be reached for stream information.");
  }
  if (profiles.length === 0) {
    throw new CommissioningError("This camera didn't report any usable video stream profiles.");
  }

  const main = profiles.find((p) => p.isLikelyMain) ?? profiles[0]!;
  const sub = profiles.find((p) => p.token !== main.token) ?? null;

  const [mainUri, subUri] = await Promise.all([
    getStreamUri(mediaEndpoint, main.token, opts.credentials, fetchImpl).catch(() => null),
    sub ? getStreamUri(mediaEndpoint, sub.token, opts.credentials, fetchImpl).catch(() => null) : Promise.resolve(null),
  ]);

  if (!mainUri) throw new CommissioningError("The camera didn't return a stream address.");

  return {
    manufacturer: info.manufacturer,
    model: info.model,
    mainStreamUri: mainUri,
    subStreamUri: subUri,
    mainProfileToken: main.token,
    subProfileToken: sub?.token ?? null,
  };
}

export class CommissioningError extends Error {}

/** Injects `user:pass@` into an RTSP URI's authority — the ONLY place credentials and a stream URL
 * are ever combined, and only transiently (never persisted this way; see the gateway route for
 * how credentials are actually stored, separately and encrypted). */
export function withCredentials(rtspUri: string, creds: CommissionCredentials): string {
  try {
    const url = new URL(rtspUri);
    url.username = encodeURIComponent(creds.username);
    url.password = encodeURIComponent(creds.password);
    return url.toString();
  } catch {
    return rtspUri;
  }
}

/** Strips any embedded userinfo from an RTSP URL — the form persisted in `Device.metadata`, which
 * must never carry credentials (§ STEP 5/11). */
export function stripCredentials(rtspUri: string): string {
  try {
    const url = new URL(rtspUri);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return rtspUri;
  }
}

export interface ValidateOptions {
  rtspUrl: string;
  username?: string | null;
  password?: string | null;
  timeoutMs?: number;
  socketFactory?: RtspSocketFactory;
}

/** § STEP 8 — real stream validation, shared by both the ONVIF and RTSP-only manual flows (the
 * one true validation path, never duplicated per flow). */
export function testConnection(opts: ValidateOptions): Promise<RtspStreamCheck> {
  return validateRtspStream({
    url: opts.rtspUrl,
    username: opts.username,
    password: opts.password,
    timeoutMs: opts.timeoutMs,
    socketFactory: opts.socketFactory,
  });
}

export { validateRtspUrl };
