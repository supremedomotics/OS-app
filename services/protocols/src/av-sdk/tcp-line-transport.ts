import net from "node:net";
import { ReconnectScheduler } from "../avr-reconnect.js";
import { LineAccumulator } from "../line-buffer.js";
import { DriverDiagnosticsTracker } from "../driver-diagnostics.js";

/**
 * SupremeOS Universal AV SDK (§ Universal AV SDK Architecture) — pooled, reconnecting,
 * line-buffered TCP transport.
 *
 * Extracted from `AvrProtocolDriver` and `HeosProtocolDriver`'s near-identical
 * `AvrLink`/`HeosLink` + `ensureLink()`/`openSocket()`/`onData()`/`disconnect()`-loop +
 * `getDiagnostics()` status-ternary — confirmed by the duplication audit to be ~55 lines
 * of copy-pasted plumbing between the two drivers, differing only in the line delimiter
 * and each protocol's own init-command sequence. This is the ONLY transport variant with
 * two real callers today (both are persistent-TCP, line-delimited protocols); Yamaha's
 * HTTP+UDP transport has no second caller in the fleet, so it deliberately stays out of
 * this module — see `docs/architecture/Universal-AV-SDK.md` for the full scoping rationale.
 *
 * Ownership split: this class owns the socket/reconnect/line-buffer/diagnostics-counter
 * lifecycle for a `Map<key, TcpLink>` pool. It does NOT own device/binding bookkeeping —
 * a driver decides its own `key` shape (`host:port` in practice), calls `ensureLink()` to
 * get-or-create a link, and supplies two hooks so protocol-specific behavior (the
 * init-command sequence sent on connect, and how an inbound line becomes a Supreme state
 * update) stays entirely in the driver, never in this transport.
 */

export interface TcpLink {
  socket: net.Socket | null;
  /** True only once THIS socket's "connect" event has actually fired — a freshly-created
   * socket is non-null but not yet connected, so `socket !== null` alone isn't a safe
   * "can I write to this" check. */
  ready: boolean;
  buffer: LineAccumulator;
  reconnect: ReconnectScheduler;
  diagnostics: DriverDiagnosticsTracker;
}

export type TcpLineTransportStatus = "connected" | "connecting" | "disconnected";

export interface TcpLineTransportOptions {
  /** Line delimiter passed to `LineAccumulator` (e.g. `"\r"` for Denon/Marantz Telnet,
   * `"\r\n"` for the HEOS CLI). */
  delimiter: string;
  /** Reconnect backoff floor / ceiling (ms). Defaults 2_000 / 60_000 (`ReconnectScheduler`'s own defaults). */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Injectable socket factory (tests point at an in-process server); defaults to `net.connect`. */
  createSocket?: (host: string, port: number) => net.Socket;
  /** Called once a link's socket "connect" event fires, AFTER `link.ready` is set and the
   * reconnect scheduler is reset — write the protocol's init-command sequence here via
   * `socket.write(...)`, recording each via `link.diagnostics.recordSend(...)`. `socket` is
   * guaranteed non-null here (it's the same socket that just connected) — a separate
   * parameter from `link.socket` (which stays nullable) specifically so callers never need
   * a null-check/assertion for something that's always true at this call site. */
  onConnect: (link: TcpLink, socket: net.Socket, host: string, port: number) => void;
  /** Called once per complete line received on any link. `ctx.link` is always the CURRENT
   * link for `ctx.key` (re-resolved from the pool, not a stale closure reference), matching
   * the re-entrancy safety the original per-driver `onData()` implementations already had. */
  onLine: (ctx: { key: string; host: string; port: number; link: TcpLink }, line: string) => void;
  /** Surfaces connection lifecycle events (connect/error/buffer-overflow) — mirrors each
   * driver's existing `onLog` option. */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

export class TcpLineTransport {
  private readonly links = new Map<string, TcpLink>();
  private readonly opts: TcpLineTransportOptions;

  constructor(opts: TcpLineTransportOptions) {
    this.opts = opts;
  }

  /** The current link for `key`, or `undefined` if none exists yet — never creates one
   * (contrast `ensureLink()`). Used by diagnostics/queue-style reads that must not open a
   * connection just to answer "what's the current state." */
  get(key: string): TcpLink | undefined {
    return this.links.get(key);
  }

  /**
   * Reuse-or-create the link for `key`. Preserves the exact original re-entrancy guard —
   * `socket && !socket.destroyed` (NOT `ready`) — so a still-connecting link is reused
   * rather than racing a second connection attempt when `bind()`/`command()`/a queue read
   * call this concurrently for the same key before the first connect resolves.
   */
  ensureLink(key: string, host: string, port: number): TcpLink {
    let link = this.links.get(key);
    if (link?.socket && !link.socket.destroyed) return link;
    if (link) {
      // Re-establishing a previously-dropped link — reuse its reconnect scheduler state.
      this.openSocket(link, key, host, port);
      return link;
    }
    const reconnect = new ReconnectScheduler({
      baseMs: this.opts.reconnectBaseMs,
      maxMs: this.opts.reconnectMaxMs,
      reconnect: async () => {
        const l = this.links.get(key);
        if (l) {
          l.diagnostics.recordReconnect();
          this.openSocket(l, key, host, port);
        }
      },
    });
    link = {
      socket: null,
      ready: false,
      buffer: new LineAccumulator(this.opts.delimiter, undefined, () =>
        this.opts.onLog?.(
          "error",
          `${host}:${port}: inbound buffer overflowed without a delimiter — dropped and reset (possible flood or malformed device response)`,
        )),
      reconnect,
      diagnostics: new DriverDiagnosticsTracker(),
    };
    this.links.set(key, link);
    this.openSocket(link, key, host, port);
    return link;
  }

  private openSocket(link: TcpLink, key: string, host: string, port: number): void {
    link.ready = false;
    const socket = this.opts.createSocket ? this.opts.createSocket(host, port) : net.connect(port, host);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(key, host, port, chunk));
    socket.on("connect", () => {
      link.ready = true;
      link.reconnect.reset();
      this.opts.onLog?.("info", `Connected to ${host}:${port}`);
      this.opts.onConnect(link, socket, host, port);
    });
    socket.on("close", () => {
      const l = this.links.get(key);
      // § Capability Refresh — `close` fires asynchronously, on a later tick than
      // `destroy()` was called on it. If this exact key was released and immediately
      // re-established in between (e.g. `releaseKey()` followed straight away by
      // `ensureLink()` for a forced reconnect), `l` is now a DIFFERENT link object
      // whose own, already-connecting-or-connected socket must not be clobbered by
      // this stale socket's belated close event — only mutate when it's genuinely
      // still this socket's own link.
      if (l && l.socket === socket) {
        l.socket = null;
        l.ready = false;
        l.reconnect.notifyDisconnected();
      }
    });
    socket.on("error", (err) => {
      // The "close" handler still runs right after this (Node always fires close following
      // error) and drives reconnection — this just makes the failure visible instead of silent.
      link.diagnostics.recordError(err.message);
      this.opts.onLog?.("error", `${host}:${port}: ${err.message}`);
    });
    link.socket = socket;
  }

  private onData(key: string, host: string, port: number, chunk: string): void {
    // Re-resolve the CURRENT link for this key rather than closing over the one `openSocket`
    // was called with — a link can be replaced (reconnect) between when this handler was
    // registered and when data arrives, and matching the original per-driver behavior means
    // always operating on whatever the pool considers current.
    const link = this.links.get(key);
    if (!link) return;
    const lines = link.buffer.feed(chunk);
    for (const line of lines) {
      if (line.trim()) link.diagnostics.recordReceive(line);
      this.opts.onLine({ key, host, port, link }, line);
    }
  }

  /** Status + diagnostics for `key`'s link, in the shape every driver's own
   * `getDiagnostics()` needs to build its final snapshot — this method does NOT know
   * `model`/`firmware`/`ip`/`mac` (driver-specific), only connection status and the raw
   * counters. Returns a fresh, empty tracker (never `null`) when no link exists yet, so
   * callers can call `.snapshot()` on the result unconditionally. */
  diagnosticsFor(key: string): { status: TcpLineTransportStatus; diagnostics: DriverDiagnosticsTracker } {
    const link = this.links.get(key);
    const status: TcpLineTransportStatus = !link ? "disconnected" : link.ready ? "connected" : link.socket ? "connecting" : "disconnected";
    return { status, diagnostics: link?.diagnostics ?? new DriverDiagnosticsTracker() };
  }

  /** Tear down every link — stop each one's reconnect scheduler, destroy its socket, clear
   * the pool. Whole-driver `disconnect()`. */
  disconnectAll(): void {
    for (const link of this.links.values()) {
      link.reconnect.stop();
      link.socket?.destroy();
    }
    this.links.clear();
  }

  /** Unconditional teardown of ONE key — stop its reconnect scheduler, destroy its socket,
   * remove it from the pool. Has no visibility into whether any device binding still
   * references this key; that "is this still in use" check stays in the driver's own
   * `unbind()`, exactly as it does today — this method is only ever called once the driver
   * has already determined the key is orphaned. Idempotent (a no-op for an unknown key). */
  releaseKey(key: string): void {
    const link = this.links.get(key);
    if (link) {
      link.reconnect.stop();
      link.socket?.destroy();
      this.links.delete(key);
    }
  }
}
