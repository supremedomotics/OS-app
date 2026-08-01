import type { UdpTransportFactory } from "@supreme/lan";
import type { MdnsSocket, MdnsSocketFactory } from "../mdns.js";

/**
 * Migration adapter (§ Production Architecture Refactor). Implements `MdnsSocket` exactly as
 * `mdnsBrowse` already expects it, backed by a `supreme-lan` `UdpTransport`. Drop-in alternative
 * to `mdns.ts`'s existing real-`dgram` `defaultSocket()` — `mdnsBrowse` still defaults to it
 * unchanged; this factory is passed only via the existing `createSocket` option.
 *
 * No multicast group join is needed here: `mdns.ts`'s query sets the DNS "QU" bit (p.32's own
 * comment: "responders unicast back to us"), so the existing implementation has never joined
 * `224.0.0.251` as a membership — it only sends TO that address and receives ordinary unicast
 * replies. This adapter preserves that exactly; it does not add a join this driver never needed.
 * DNS-SD wire encode/decode (`encodeQuery`/`decodeMessage`) is untouched — this only moves bytes.
 */
export function createMdnsRemoteSocketFactory(makeTransport: UdpTransportFactory): MdnsSocketFactory {
  return (): MdnsSocket => {
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
