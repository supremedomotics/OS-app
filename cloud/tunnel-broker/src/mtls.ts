import { connect as tlsConnect, createServer as tlsCreateServer, type TLSSocket } from "node:tls";
import { TunnelBroker, type TunnelRequest, type TunnelResponse } from "./broker.js";

/**
 * Real device-cert MUTUAL-TLS tunnel transport (ADR 0009). The hub dials OUT to the broker over
 * TLS and presents its X.509 device certificate; the broker runs the TLS server with
 * `requestCert` + `rejectUnauthorized` and the kernel/OpenSSL verifies the client cert chains to
 * the Hub CA BEFORE any app code runs — genuine transport-layer auth, not an app-layer challenge.
 * The hub id is the cert CN. Messages are length-prefixed JSON frames over the TLS stream;
 * heartbeats drive presence (stale connections are evicted), and the hub auto-reconnects.
 *
 * This is the mutually-authenticated stream the routing core ({@link TunnelBroker}) sits on. QUIC/
 * HTTP-3 is a drop-in replacement for this transport (terminated at the edge or via a future Node
 * QUIC binding) — the broker's framing + routing are unchanged.
 */

// ── length-prefixed JSON framing ─────────────────────────────────────────────────────────────
function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

/** Accumulates stream chunks and yields complete frames as they arrive. */
class FrameReader {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): string[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: string[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      out.push(this.buf.subarray(4, 4 + len).toString("utf8"));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

// ── broker side: mTLS server feeding a TunnelBroker ───────────────────────────────────────────
export interface MtlsServerOptions {
  /** Broker server cert + key (PEM). */
  cert: string;
  key: string;
  /** Hub CA (PEM) — device certs are verified against this. */
  caCert: string;
  broker: TunnelBroker;
  /** Heartbeat interval (ms). A hub that misses 2 pongs is evicted. */
  heartbeatMs?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface MtlsTunnelServer {
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  /** Currently-connected hub count (presence). */
  readonly connections: number;
}

export function createMtlsTunnelServer(opts: MtlsServerOptions): MtlsTunnelServer {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const log = opts.log ?? (() => {});
  const live = new Set<TLSSocket>();

  const server = tlsCreateServer(
    { cert: opts.cert, key: opts.key, ca: [opts.caCert], requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" },
    (socket) => {
      // The cert already chains to the Hub CA (rejectUnauthorized). Read the hub id from its CN.
      const peer = socket.getPeerCertificate();
      const hubId = (peer && typeof peer.subject === "object" ? peer.subject.CN : undefined) as string | undefined;
      if (!hubId) {
        socket.destroy();
        return;
      }
      live.add(socket);
      const reader = new FrameReader();
      const detach = opts.broker.attach(hubId, { send: (data) => socket.write(encodeFrame(JSON.parse(data))) });

      let missed = 0;
      const hb = setInterval(() => {
        if (missed >= 2) {
          log("evicting stale hub", { hubId });
          socket.destroy();
          return;
        }
        missed += 1;
        socket.write(encodeFrame({ t: "ping" }));
      }, heartbeatMs);
      hb.unref?.();

      socket.on("data", (chunk: Buffer) => {
        for (const raw of reader.push(chunk)) {
          let frame: { t?: string };
          try {
            frame = JSON.parse(raw);
          } catch {
            continue;
          }
          if (frame.t === "pong") {
            missed = 0;
            continue;
          }
          // Response frames from the hub flow into the routing core.
          opts.broker.handleMessage(hubId, raw);
        }
      });
      const cleanup = () => {
        clearInterval(hb);
        live.delete(socket);
        detach();
      };
      socket.on("close", cleanup);
      socket.on("error", () => socket.destroy());
      log("hub connected (mTLS)", { hubId });
    },
  );
  // An unauthorized client (bad/missing cert) trips this before any connection handler.
  server.on("tlsClientError", () => {});

  return {
    get connections() {
      return live.size;
    },
    listen: (port, host = "0.0.0.0") =>
      new Promise<number>((resolve) => server.listen(port, host, () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      })),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of live) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// ── hub side: mTLS client (outbound-only, reconnecting) ───────────────────────────────────────
export interface MtlsClientOptions {
  host: string;
  port: number;
  /** Server CN to verify (TLS SNI / identity check). */
  servername: string;
  /** Hub device cert + key (PEM). */
  cert: string;
  key: string;
  /** CA (PEM) the hub trusts for the broker's server cert. */
  caCert: string;
  /** Proxy a forwarded request to the local gateway and return the response. */
  onRequest: (req: TunnelRequest) => Promise<TunnelResponse>;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onReady?: () => void;
  log?: (msg: string) => void;
}

export class MtlsTunnelClient {
  private socket: TLSSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private readonly reader = new FrameReader();

  constructor(private readonly opts: MtlsClientOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = tlsConnect({
      host: this.opts.host,
      port: this.opts.port,
      servername: this.opts.servername,
      cert: this.opts.cert,
      key: this.opts.key,
      ca: [this.opts.caCert],
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    this.socket = socket;
    socket.on("secureConnect", () => {
      this.attempt = 0;
      this.opts.onReady?.();
    });
    socket.on("data", (chunk: Buffer) => {
      for (const raw of this.reader.push(chunk)) void this.onFrame(socket, raw);
    });
    socket.on("close", () => this.scheduleReconnect());
    socket.on("error", () => socket.destroy());
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    // Exponential backoff with full jitter so a fleet doesn't reconnect in lockstep.
    const base = this.opts.reconnectBaseMs ?? 500;
    const max = this.opts.reconnectMaxMs ?? 30_000;
    const ceil = Math.min(max, base * 2 ** Math.min(this.attempt, 10));
    this.attempt += 1;
    const delay = Math.floor(Math.random() * ceil);
    const t = setTimeout(() => this.connect(), delay);
    (t as { unref?: () => void }).unref?.();
  }

  private async onFrame(socket: TLSSocket, raw: string): Promise<void> {
    let frame: { t?: string; id?: string } & Partial<TunnelRequest>;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.t === "ping") {
      socket.write(encodeFrame({ t: "pong" }));
      return;
    }
    if (frame.t === "req" && frame.id) {
      const res = await this.opts.onRequest({
        method: frame.method ?? "GET",
        path: frame.path ?? "/",
        headers: frame.headers ?? {},
        body: frame.body,
      });
      socket.write(encodeFrame({ t: "res", id: frame.id, ...res }));
    }
  }
}
