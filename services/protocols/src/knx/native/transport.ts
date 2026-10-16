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
