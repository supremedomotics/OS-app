import type { AppleTvClient, AppleTvConnect, AppleTvNowPlaying } from "./apple-tv-driver.js";

/**
 * Node client for the Python Apple TV bridge (`services/appletv-py`).
 *
 * The driver's {@link AppleTvClient} seam is fulfilled over HTTP by the pyatv-backed
 * bridge, which holds the per-device pairing credentials. This factory turns a bridge
 * base URL into an {@link AppleTvConnect}: on `connect(address)` it opens a control
 * session on the bridge (using the stored credentials) and returns a client whose
 * control + now-playing calls map to the bridge's per-device endpoints.
 *
 * Pairing itself is an interactive PIN flow done once at commissioning time (the
 * bridge's /pair/begin + /pair/pin endpoints, surfaced by the installer tooling); by
 * bind time the device is already paired, so `connect()` just resumes it.
 */
export interface AppleTvBridgeOptions {
  /** Base URL of the appletv-py bridge, e.g. "http://appletv:9300". */
  baseUrl: string;
  /** Injectable fetch (tests point this at an in-process bridge). */
  fetchImpl?: typeof fetch;
}

interface BridgeNowPlaying {
  state?: string;
  app?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  artwork_url?: string | null;
  volume?: number;
  muted?: boolean;
}

const VALID_STATES = new Set(["playing", "paused", "stopped", "idle"]);

export function createAppleTvConnect(opts: AppleTvBridgeOptions): AppleTvConnect {
  const base = opts.baseUrl.replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  async function call(path: string, body?: unknown): Promise<unknown> {
    const res = await fetchImpl(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const j = (await res.json()) as { detail?: string };
        if (j.detail) detail = j.detail;
      } catch {
        // non-JSON error body; keep the status code
      }
      throw new Error(`appletv-bridge: ${detail}`);
    }
    return res.json().catch(() => ({}));
  }

  return async (address: string): Promise<AppleTvClient> => {
    await call("/connect", { address });
    const enc = encodeURIComponent(address);
    const cmd = (action: string, volume?: number) =>
      call(`/devices/${enc}/command`, volume === undefined ? { action } : { action, volume });
    return {
      play: () => cmd("play").then(() => undefined),
      pause: () => cmd("pause").then(() => undefined),
      stop: () => cmd("stop").then(() => undefined),
      next: () => cmd("next").then(() => undefined),
      previous: () => cmd("previous").then(() => undefined),
      setVolume: (percent) => cmd("volume", Math.round(percent)).then(() => undefined),
      setMuted: (muted) => cmd(muted ? "mute" : "unmute").then(() => undefined),
      nowPlaying: async (): Promise<AppleTvNowPlaying> => {
        const np = (await call(`/devices/${enc}/now_playing`)) as BridgeNowPlaying;
        const state = np.state && VALID_STATES.has(np.state) ? np.state : "idle";
        return {
          state: state as AppleTvNowPlaying["state"],
          app: np.app ?? null,
          title: np.title ?? null,
          artist: np.artist ?? null,
          artworkUrl: np.artwork_url ?? null,
          volume: typeof np.volume === "number" ? np.volume : 0,
          muted: Boolean(np.muted),
        };
      },
    };
  };
}
