import type { UdpTransportFactory } from "@supreme/lan";
import type { KnxDiscoverySocket, KnxDiscoverySocketFactory } from "../knx-discovery.js";

/**
 * Migration adapter (§ Production Architecture Refactor). Implements `KnxDiscoverySocket` exactly
 * as `knxSearch` already expects it, backed by a `supreme-lan` `UdpTransport`. Drop-in alternative
 * to `knx-discovery.ts`'s existing real-`dgram` `defaultSocket()` — `knxSearch` still defaults to
 * it unchanged; this factory is passed only via the existing `createSocket` option.
 *
 * `knxSearch`'s own real call sequence is two-phase — `bind(cb, address)` completes, THEN inside
 * that callback `setMulticast?.(interfaceAddress)` joins the KNX system-setup multicast group
 * (224.0.23.12), THEN `send()` — which is exactly why `UdpTransport` has a separate
 * `joinMulticast()` distinct from `bind({multicastGroup})`: this adapter binds first, waits for
 * it to genuinely complete, invokes `cb()`, and only then does `setMulticast()` (called
 * synchronously inside that callback, per `knxSearch`) join the group. KNXnet/IP frame
 * encoding/parsing (`encodeSearchRequest`/`parseSearchResponse`) is untouched — this adapter only
 * moves the `Buffer`s `knxSearch` already produces/expects.
 */
export function createKnxDiscoveryRemoteSocketFactory(makeTransport: UdpTransportFactory): KnxDiscoverySocketFactory {
  return (): KnxDiscoverySocket => {
    const transport = makeTransport();
    const messageListeners = new Set<(msg: Buffer, rinfo: { address: string }) => void>();
    transport.onMessage((msg, rinfo) => {
      for (const l of messageListeners) l(msg, rinfo);
    });

    return {
      on(_event, cb) {
        messageListeners.add(cb);
      },
      bind(cb: () => void, address?: string): void {
        transport
          .bind({ localAddress: address })
          .then(() => cb())
          .catch(() => {
            // `KnxDiscoverySocket` has no error channel — matches the existing interface shape
            // exactly (the real `defaultSocket()` has the same gap: a real bind failure there
            // only ever surfaces as a rejected/unsettled promise up in `knxSearch`, never a
            // distinct error callback). Not something this adapter can fix without changing the
            // interface `knx-discovery.ts` already commits to.
          });
      },
      setMulticast(interfaceAddress?: string): void {
        void transport.joinMulticast("224.0.23.12", interfaceAddress);
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
