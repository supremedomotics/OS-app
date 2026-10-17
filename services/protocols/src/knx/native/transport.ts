/**
 * Injectable I/O seams for the native KNX stack (§ Clean-room KNX stack — transport
 * interfaces). Protocol and session logic never touch `node:dgram` or global timers
 * directly; they receive these two interfaces, so the same code runs against real UDP in
 * production and against a deterministic in-memory network + manual clock in tests and
 * in the virtual bus simulator.
 */

export interface RemoteInfo {
  address: string;
  port: number;
}

export interface KnxDatagramSocket {
  /** Sends one datagram. Must not throw for unreachable peers (UDP is fire-and-forget);
   * genuine local failures are reported through {@link SocketHandlers.onError}. */
  send(data: Buffer, port: number, address: string): void;
  /** Releases the OS resource. Idempotent. After close no handler is invoked. */
  close(): void;
  /** Local port the socket is bound to (for diagnostics). */
  readonly localPort: number;
}

export interface SocketHandlers {
  onMessage(data: Buffer, from: RemoteInfo): void;
  onError(error: Error): void;
}

export type SocketFactory = (handlers: SocketHandlers) => Promise<KnxDatagramSocket> | KnxDatagramSocket;

declare const timerBrand: unique symbol;
/** Opaque timer token; only a {@link Clock} creates or interprets one. */
export interface TimerHandle { readonly [timerBrand]: true }

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Production clock. Timers are unref'd so a forgotten session can never keep the process
 * alive on its own. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t as unknown as TimerHandle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as unknown as NodeJS.Timeout);
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Stream (TCP) seam — used by KNX IP Secure, whose unicast sessions "must use TCP and must not use UDP" (IPS §2.2.3.3).

export interface KnxStreamSocket {
  /** Queues bytes for the peer. Must not throw once connected; failures surface through {@link StreamHandlers.onClose}. */
  write(data: Buffer): void;
  /** Orderly close (FIN). Idempotent. */
  end(): void;
  /** Immediate close. Idempotent. After this no handler is invoked. */
  destroy(): void;
}

export interface StreamHandlers {
  onData(data: Buffer): void;
  /** Called exactly once when the connection is gone (peer FIN, reset, local destroy never calls it). */
  onClose(error?: Error): void;
}

/** Opens one connection to the (fixed) gateway endpoint. Rejects if the connection cannot be established. */
export type StreamFactory = (handlers: StreamHandlers) => Promise<KnxStreamSocket> | KnxStreamSocket;

/**
 * Marks a stream factory as in-memory only. Unverified protocol rules (see tunnel-rules.ts) may be exercised ONLY over a marked factory; a real
 * factory (tcp-socket.ts) is never marked, so it is refused wherever a rule is unverified.
 */
const SIMULATED = Symbol.for("supremeos.knx.simulatedTransport");
export function markSimulated<F extends StreamFactory>(f: F): F { Object.defineProperty(f, SIMULATED, { value: true }); return f; }
export function isSimulated(f: StreamFactory): boolean { return (f as unknown as Record<symbol, unknown>)[SIMULATED] === true; }
