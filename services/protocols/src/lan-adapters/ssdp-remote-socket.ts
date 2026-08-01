import type { UdpTransportFactory } from "@supreme/lan";
import type { SsdpSocket, SsdpSocketFactory } from "../ssdp.js";

/**
 * Migration adapter (§ Production Architecture Refactor). Implements `SsdpSocket` exactly as
 * `ssdpSearch` already expects it, backed by a `supreme-lan` `UdpTransport`. Drop-in alternative
 * to `ssdp.ts`'s existing real-`dgram` `defaultSocket()` — `ssdpSearch` still defaults to it
 * unchanged; this factory is passed only via the existing `createSocket` option.
 *
 * No multicast group join is needed: SSDP M-SEARCH responses are unicast directly back to the
 * search request's source (standard UPnP behavior) — the existing implementation only ever sends
 * TO `239.255.255.250` and receives ordinary unicast replies, exactly preserved here. SSDP's
 * HTTP-style response parsing (`parseSsdpResponse`) is untouched — this only moves bytes.
 */
export function createSsdpRemoteSocketFactory(makeTransport: UdpTransportFactory): SsdpSocketFactory {
  return (): SsdpSocket => {
    const transport = makeTransport();
    const messageListeners = new Set<(msg: Buffer, rinfo: { address: string }) => void>();
    transport.onMessage((msg, rinfo) => {
      for (const l of messageListeners) l(msg, rinfo);
    });
    return {
      on(_event, cb) {
        messageListeners.add(cb);
      },
      bind(cb: () => void): void {
        void transport.bind().then(() => cb());
      },
      send(msg: Buffer, port: number, host: string): void {
        void transport.send(msg, port, host);
      },
      close(): void {
        void transport.close();
      },
    };
  };
}
