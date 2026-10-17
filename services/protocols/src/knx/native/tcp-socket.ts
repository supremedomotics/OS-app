/**
 * Real TCP implementation of {@link StreamFactory} on `node:net` (§ KNX IP Secure — transport; IPS §2.2.3.3: unicast secure sessions
 * "must use TCP"). With udp-socket.ts, the only file in the native stack that opens a network socket.
 *
 * Scope: a byte-stream pipe to ONE configured endpoint. It deliberately knows nothing about KNX (framing is secure/stream.ts, session
 * rules are secure/ip-session.ts) and applies NO destination policy: the gateway address is whatever the installer configured. The
 * in-memory simulator (simulator/virtual-stream.ts) is a separate implementation that cannot open sockets — see tcp-socket.test.ts.
 *
 * Decisions (not specification text; KNXnet/IP Core v2 is absent from the supplied bundle):
 *   - connect timeout (default 10 s), bounded write queue (default 1 MiB), and a linger bound after end() so a peer that never answers
 *     our FIN cannot keep the descriptor open;
 *   - TCP_NODELAY on (small request/response frames must not be delayed by Nagle);
 *   - an exception thrown by a handler destroys the connection instead of escaping into the event loop.
 */
import { Socket, connect as netConnect } from "node:net";
import type { KnxStreamSocket, StreamFactory, StreamHandlers } from "./transport.js";

export interface TcpSocketOptions {
  host: string;
  port: number;
  /** Bind the local end to this interface address (multi-homed hosts). */
  localAddress?: string;
  connectTimeoutMs?: number;
  /** Upper bound for bytes queued but not yet accepted by the kernel; exceeding it resets the connection. */
  maxQueuedBytes?: number;
  /** After end(), the connection is destroyed if the peer has not closed within this time. */
  lingerMs?: number;
  /** TEST SEAM: produces the (not yet connected) socket. Default: a real `node:net` connection. */
  createSocket?: (o: { host: string; port: number; localAddress?: string }) => Socket;
}

export class TcpConnectError extends Error {
  constructor(readonly code: "connect_timeout" | "connect_failed" | "invalid_endpoint", message: string) {
    super(message);
    this.name = "TcpConnectError";
  }
}

export function createTcpStreamFactory(opts: TcpSocketOptions): StreamFactory {
  if (typeof opts.host !== "string" || opts.host.length === 0) throw new TcpConnectError("invalid_endpoint", "host must be a non-empty string");
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new TcpConnectError("invalid_endpoint", "port must be 1–65535");
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const maxQueuedBytes = opts.maxQueuedBytes ?? 1_048_576;
  const lingerMs = opts.lingerMs ?? 2_000;

  return (handlers: StreamHandlers) =>
    new Promise<KnxStreamSocket>((resolve, reject) => {
      const target = { host: opts.host, port: opts.port, ...(opts.localAddress ? { localAddress: opts.localAddress } : {}) };
      const sock = opts.createSocket ? opts.createSocket(target) : netConnect(target);
      sock.setNoDelay(true);

      let connected = false;
      let localClose = false;     // end()/destroy() requested here: no onClose callback for destroy; end() reports when the peer completes
      let destroyedByUs = false;
      let closeReported = false;
      let lastError: Error | undefined;
      let lingerTimer: NodeJS.Timeout | undefined;

      const connectTimer = setTimeout(() => {
        if (connected) return;
        sock.destroy();
        reject(new TcpConnectError("connect_timeout", `no TCP connection to ${opts.host}:${opts.port} within ${connectTimeoutMs} ms`));
      }, connectTimeoutMs);
      connectTimer.unref();

      const reportClosed = (err?: Error): void => {
        if (closeReported || destroyedByUs) return;
        closeReported = true;
        try { handlers.onClose(err); } catch { /* a faulty handler must not crash the process */ }
      };
      const killByFault = (err: Error): void => {   // reset the connection and tell the owner exactly once
        if (closeReported) return;
        lastError = err;
        sock.destroy();
      };

      sock.on("error", (e) => { lastError = e; });   // 'close' follows every 'error'
      sock.once("connect", () => {
        connected = true;
        clearTimeout(connectTimer);
        sock.on("data", (d: Buffer) => {
          try { handlers.onData(d); } catch (e) { killByFault(e instanceof Error ? e : new Error(String(e))); }
        });
        resolve({
          write(data: Buffer): void {
            if (sock.destroyed || localClose) return;
            sock.write(data);
            if (sock.writableLength > maxQueuedBytes) killByFault(new Error(`write queue exceeded ${maxQueuedBytes} bytes`));
          },
          end(): void {
            if (localClose) return;
            localClose = true;
            sock.end();
            lingerTimer = setTimeout(() => sock.destroy(), lingerMs);
            lingerTimer.unref();
          },
          destroy(): void {
            if (destroyedByUs) return;
            destroyedByUs = true;
            localClose = true;
            if (lingerTimer) clearTimeout(lingerTimer);
            sock.destroy();
          },
        });
      });
      sock.once("close", () => {
        clearTimeout(connectTimer);
        if (lingerTimer) clearTimeout(lingerTimer);
        if (!connected) {
          reject(new TcpConnectError("connect_failed", `cannot connect to ${opts.host}:${opts.port}: ${lastError?.message ?? "closed"}`));
          return;
        }
        reportClosed(lastError);
      });
    });
}
