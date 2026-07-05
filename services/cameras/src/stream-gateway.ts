/**
 * Camera stream gateway (§11.1 cameras). RTSP is the camera's *source* protocol — it
 * is NOT directly playable in a browser or the Flutter app. The hub runs a streaming
 * engine (go2rtc or MediaMTX) that ingests the RTSP source and republishes it as
 * **HLS** (universally playable) and **WebRTC** (low-latency). This gateway is the only
 * thing that knows those engine URL conventions; it turns an `rtsp://…` source into the
 * client-playable URLs the API hands out, and (optionally) registers the source with
 * the engine so it's pulled on demand.
 */
export type StreamKind = "hls" | "webrtc" | "rtsp";

export interface CameraStream {
  kind: StreamKind;
  url: string;
}

export type StreamEngine = "go2rtc" | "mediamtx";

export interface StreamGatewayOptions {
  /** Streaming engine the hub runs (default "go2rtc"). */
  engine?: StreamEngine;
  /** Public base URL clients reach the streamer at, e.g. "https://hub.local/stream". */
  baseUrl: string;
  /** Engine admin API base for dynamic source registration; omit if config-driven. */
  apiUrl?: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface ICameraStreamGateway {
  /** Register an RTSP source under a stream name; return client-playable streams. */
  publish(name: string, rtspSource: string): Promise<CameraStream[]>;
  /** Stop a published stream. */
  unpublish(name: string): Promise<void>;
  /** Whether a stream engine is configured at all. */
  readonly enabled: boolean;
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** Derive the client-playable HLS + WebRTC URLs for a stream name per engine convention. */
export function playableUrls(engine: StreamEngine, baseUrl: string, name: string): CameraStream[] {
  const b = trimSlash(baseUrl);
  const q = encodeURIComponent(name);
  if (engine === "mediamtx") {
    return [
      { kind: "hls", url: `${b}/${name}/index.m3u8` },
      { kind: "webrtc", url: `${b}/${name}/whep` },
    ];
  }
  // go2rtc
  return [
    { kind: "hls", url: `${b}/api/stream.m3u8?src=${q}` },
    { kind: "webrtc", url: `${b}/api/webrtc?src=${q}` },
  ];
}

export class StreamGateway implements ICameraStreamGateway {
  private readonly engine: StreamEngine;
  private readonly baseUrl: string;
  private readonly apiUrl?: string;
  private readonly fetchImpl: typeof fetch;
  readonly enabled: boolean;

  constructor(opts: StreamGatewayOptions) {
    this.engine = opts.engine ?? "go2rtc";
    this.baseUrl = opts.baseUrl;
    this.apiUrl = opts.apiUrl;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.enabled = Boolean(opts.baseUrl);
  }

  async publish(name: string, rtspSource: string): Promise<CameraStream[]> {
    // Best-effort dynamic registration when an engine admin API is configured. With a
    // config-driven engine this is a no-op and the URLs still resolve.
    if (this.apiUrl && this.engine === "go2rtc") {
      try {
        await this.fetchImpl(
          `${trimSlash(this.apiUrl)}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(rtspSource)}`,
          { method: "PUT" },
        );
      } catch {
        // Registration is advisory; the playable URLs are still returned.
      }
    }
    return [...playableUrls(this.engine, this.baseUrl, name), { kind: "rtsp", url: rtspSource }];
  }

  async unpublish(name: string): Promise<void> {
    if (this.apiUrl && this.engine === "go2rtc") {
      try {
        await this.fetchImpl(`${trimSlash(this.apiUrl)}/api/streams?src=${encodeURIComponent(name)}`, {
          method: "DELETE",
        });
      } catch {
        /* advisory */
      }
    }
  }
}

/** A disabled gateway for hubs with no streamer configured. */
export class NullStreamGateway implements ICameraStreamGateway {
  readonly enabled = false;
  async publish(): Promise<CameraStream[]> {
    return [];
  }
  async unpublish(): Promise<void> {}
}
