import { DriverDiagnosticsTracker } from "../driver-diagnostics.js";
import type { ProtocolTracer } from "./protocol-tracer.js";

/**
 * SupremeOS Universal AV SDK — HTTP polling client + adaptive poller (§ Universal AVR SDK).
 *
 * Generalizes `YamahaProtocolDriver`'s own ad hoc `getJson()`/`diagnosticsFor()`/in-flight-
 * coalescing pattern (`hostFeaturesInFlight`/`syncZoneInFlight`) into a reusable SDK
 * primitive — extraction is justified now by a genuine second real caller (the Denon/Marantz
 * AppCommand HTTP interface, `avr-http-codec.ts`), matching this SDK's own established bar
 * from the `TcpLineTransport` extraction: only build a shared primitive once at least two
 * real, differently-shaped callers exist, never speculatively. Yamaha itself is NOT migrated
 * onto this in the same pass — its existing polling is working and tested; force-migrating a
 * working driver purely for internal consistency would risk regressing it for no functional
 * gain (see `docs/architecture/Universal-AV-SDK.md`).
 *
 * `HttpPollClient` owns: per-key request de-duplication (a rapid burst of callers for the
 * same key coalesces onto ONE in-flight fetch, exactly like Yamaha's `hostFeaturesInFlight`
 * map), a `DriverDiagnosticsTracker` per key (so `recordSend`/`recordReceive` — and therefore
 * the automatic latency/trace capture in `driver-diagnostics.ts` — apply to HTTP traffic the
 * same way they already do to Telnet), and `ProtocolTracer` integration.
 *
 * `AdaptivePoller` owns: "only poll when absolutely unavoidable, and back off automatically
 * when idle" — the interval is a FUNCTION the caller supplies (e.g. `() => playing ? 3000 :
 * 30000`), re-evaluated before every tick, so a poller genuinely slows down the moment
 * there's nothing to poll for, without the caller having to restart it.
 */

export interface HttpPollClientOptions {
  /** Injectable fetch (tests point at an in-process HTTP server); defaults to the real
   * global fetch. Same convention as `AvrDriverOptions.fetchImpl`/`YamahaDriverOptions.fetchImpl`. */
  fetchImpl?: typeof fetch;
  tracer?: ProtocolTracer;
}

export class HttpPollClient {
  private readonly fetchImpl: typeof fetch;
  private readonly tracer: ProtocolTracer | undefined;
  private readonly diagnostics = new Map<string, DriverDiagnosticsTracker>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(opts: HttpPollClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.tracer = opts.tracer;
  }

  /** Real per-key request/response counters — same tracker shape `TcpLineTransport`'s
   * `diagnosticsFor()` returns, so a driver mixing both transports (e.g. AVR: Telnet +
   * this HTTP client) can merge them into one Diagnostics snapshot uniformly. Creates a
   * fresh tracker for an unseen key rather than returning `undefined` — callers never
   * need a null-check just to read counters that start at zero. */
  diagnosticsFor(key: string): DriverDiagnosticsTracker {
    let t = this.diagnostics.get(key);
    if (!t) {
      t = new DriverDiagnosticsTracker();
      this.diagnostics.set(key, t);
    }
    return t;
  }

  /**
   * Coalesced `GET`, returning raw response text — sugar over {@link request} for the
   * common case (matches Yamaha's `getJson()` usage exactly).
   */
  async get(key: string, url: string, init?: RequestInit): Promise<string> {
    return this.request(key, url, { method: "GET", ...init });
  }

  /**
   * Coalesced HTTP request (any method — Denon's AppCommand.xml is invoked via `POST`
   * with an XML body, unlike Yamaha's `GET`-only query-param API, so this client isn't
   * GET-only), returning raw response text (callers parse XML/JSON themselves — this
   * client has no opinion on response shape, matching `avr-codec.ts`/`avr-http-
   * codec.ts`'s "parse/build, no I/O" split). A second call for the SAME `key` while a
   * request is still in flight reuses that ONE promise instead of firing a duplicate
   * request — the exact race `YamahaProtocolDriver.hostFeaturesInFlight` exists to
   * prevent, generalized here so every HTTP-based driver gets it for free.
   */
  async request(key: string, url: string, init: RequestInit): Promise<string> {
    const inflight = this.inFlight.get(key);
    if (inflight) return inflight;
    const promise = this.doRequest(key, url, init).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async doRequest(key: string, url: string, init: RequestInit): Promise<string> {
    const tracker = this.diagnosticsFor(key);
    const method = init.method ?? "GET";
    tracker.recordSend(`${method} ${url}`);
    this.tracer?.send(`${method} ${url}`);
    try {
      const res = await this.fetchImpl(url, init);
      if (!res.ok) throw new Error(`http-poll: ${res.status} ${url}`);
      const text = await res.text();
      tracker.recordReceive(`${res.status} ${url}`);
      this.tracer?.receive(`${res.status} ${url}`);
      return text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tracker.recordError(message);
      this.tracer?.event(`request failed ${url} — ${message}`);
      throw err;
    }
  }

  /** Drop a key's diagnostics tracker — mirrors `TcpLineTransport.releaseKey()`'s role
   * in a driver's own `unbind()`: called once the driver has already determined no
   * binding references this key anymore. Does not cancel an in-flight request for that
   * key (it will simply finish and its result discarded) — matches this fleet's
   * existing "best-effort, never throws on release" convention. */
  releaseKey(key: string): void {
    this.diagnostics.delete(key);
  }
}

export interface AdaptivePollerOptions {
  /** Re-evaluated before every tick — "adaptive polling should back off automatically
   * when idle" is this function's job, not a fixed number. Returning `null` pauses
   * polling entirely (e.g. the device is powered off) without stopping/restarting the
   * poller — the next tick simply re-checks. */
  intervalMs: () => number | null;
  tick: () => void | Promise<void>;
  /** Injectable timer functions (tests use fake timers); default to the real globals. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

/**
 * "Never poll when an event exists. Only poll when absolutely unavoidable. Adaptive
 * polling should back off automatically when idle." — this class is the concrete
 * mechanism. A driver starts ONE `AdaptivePoller` per thing it genuinely can't get
 * pushed to it (e.g. AVR's now-playing metadata, which Telnet doesn't carry), and the
 * interval function decides per-tick whether/how fast to keep going.
 */
export class AdaptivePoller {
  private readonly opts: AdaptivePollerOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private inTick = false;

  constructor(opts: AdaptivePollerOptions) {
    this.opts = opts;
  }

  /** Idempotent — calling `start()` on an already-running poller is a no-op, matching
   * this fleet's other lifecycle primitives (`ReconnectScheduler`, etc.). */
  start(): void {
    if (this.timer !== null || this.stopped) return;
    this.schedule(this.opts.intervalMs());
  }

  private schedule(delay: number | null): void {
    if (this.stopped) return;
    // `null` (paused) re-checks on a short, fixed cadence rather than busy-looping or
    // requiring the caller to manually restart once conditions change — the actual
    // "should we tick" decision happens fresh in `runTick()` below, not here, so a
    // caller that flips back to paused between scheduling and firing is still honored.
    const wait = delay === null ? 5_000 : Math.max(0, delay);
    this.timer = (this.opts.setTimeoutImpl ?? setTimeout)(() => this.runTick(), wait);
  }

  private async runTick(): Promise<void> {
    this.timer = null;
    if (this.stopped || this.inTick) return;
    const delay = this.opts.intervalMs();
    if (delay === null) {
      // Still paused as of THIS moment — re-check later without ever calling tick().
      this.schedule(null);
      return;
    }
    this.inTick = true;
    try {
      await this.opts.tick();
    } finally {
      this.inTick = false;
      this.schedule(this.opts.intervalMs());
    }
  }

  /** Stop permanently — no further ticks, even one already scheduled. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      (this.opts.clearTimeoutImpl ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }
}
