import type { UdpTransportFactory } from "@supreme/lan";
import type { CasambiUdpSocketFactory, CasambiUdpSocketLike } from "../casambi/local-transport/index.js";

/**
 * Migration adapter (§ Production Architecture Refactor — SupremeOS LAN Transport Service).
 * Implements `CasambiUdpSocketLike` EXACTLY as `CasambiUdpEngine` already expects it, but backed
 * by a `supreme-lan`-provided `UdpTransport` instead of a local `node:dgram` socket. This is a
 * drop-in alternative to `CasambiUdpEngine`'s existing real-`dgram` default — passed as
 * `socketFactory` only where a caller explicitly opts in. No existing Casambi file's default
 * behavior changes: `local-gateway-transport.ts` still constructs `CasambiUdpEngine` with no
 * `socketFactory` override by default, exactly as before this file existed.
 *
 * Casambi's own wire codec (`.`-hex ASCII, CRLF-terminated) is untouched and stays in
 * `casambi/local-transport/udp-codec.ts` — this adapter only ever moves the ASCII string
 * `CasambiUdpEngine` already produces/expects, encoded to/from bytes at the transport boundary.
 */
export function createCasambiRemoteSocketFactory(makeTransport: UdpTransportFactory): CasambiUdpSocketFactory {
  return (): CasambiUdpSocketLike => {
    const transport = makeTransport();
    const messageListeners = new Set<(msg: Buffer, rinfo: { address: string; port: number }) => void>();
    const errorListeners = new Set<(err: Error) => void>();
    const listeningListeners = new Set<() => void>();

    transport.onMessage((msg, rinfo) => {
      for (const l of messageListeners) l(msg, rinfo);
    });
    transport.onError((err) => {
      for (const l of errorListeners) l(err);
    });
    transport.onListening(() => {
      for (const l of listeningListeners) l();
    });

    return {
      on(event: "message" | "error" | "listening", listener: (...args: never[]) => void): unknown {
        if (event === "message") messageListeners.add(listener as (msg: Buffer, rinfo: { address: string; port: number }) => void);
        else if (event === "error") errorListeners.add(listener as (err: Error) => void);
        else if (event === "listening") listeningListeners.add(listener as () => void);
        return this;
      },
      removeListener(event, listener) {
        if (event === "message") messageListeners.delete(listener as (msg: Buffer, rinfo: { address: string; port: number }) => void);
        else if (event === "error") errorListeners.delete(listener as (err: Error) => void);
        else if (event === "listening") listeningListeners.delete(listener as () => void);
        return this;
      },
      bind(port?: number): void {
        transport.bind({ localPort: port }).catch((err) => {
          const error = err instanceof Error ? err : new Error(String(err));
          for (const l of errorListeners) l(error);
        });
      },
      send(msg: string, port: number, address: string, callback?: (error: Error | null) => void): void {
        transport
          .send(Buffer.from(msg, "ascii"), port, address)
          .then(() => callback?.(null))
          .catch((err) => callback?.(err instanceof Error ? err : new Error(String(err))));
      },
      close(callback?: () => void): void {
        void transport.close().then(() => callback?.());
      },
      address(): { address: string; port: number; family: string } {
        const addr = transport.address();
        return addr ? { ...addr, family: "IPv4" } : { address: "0.0.0.0", port: 0, family: "IPv4" };
      },
    };
  };
}
