/**
 * The generic transport interface (§ Production Architecture Refactor — SupremeOS LAN Transport
 * Service). ONE interface for every UDP-shaped LAN need — broadcast, multicast (mDNS/SSDP/KNX
 * routing/discovery), and plain unicast. Protocol drivers consume this instead of ever opening a
 * raw socket themselves. `supreme-lan` never contains protocol/wire-codec logic: this interface
 * moves bytes only — DNS-SD record parsing, SSDP HTTP-framing, and Casambi's `.`-hex codec all
 * stay exactly where they already live in `services/protocols`, operating on the `Buffer`s this
 * interface hands them.
 *
 * mDNS (`224.0.0.251:5353`) and SSDP (`239.255.255.250:1900`) are not separate transports — they
 * are just `bind({ multicastGroup, localPort })` presets on this one interface. See
 * `services/protocols/src/lan-adapters/` for the thin adapters that give each existing
 * driver-facing socket interface (`CasambiUdpSocketLike`, `KnxDiscoverySocket`, `MdnsSocket`,
 * `SsdpSocket`) a drop-in `UdpTransport`-backed implementation.
 */
import type { LanUdpBindOptions } from "./shared/wire-types.js";

export type UdpBindOptions = LanUdpBindOptions;

export interface UdpTransport {
  bind(opts?: UdpBindOptions): Promise<void>;
  send(data: Buffer, port: number, address: string): Promise<void>;
  /** Join a multicast group AFTER an already-completed bind — a distinct capability from
   * `bind({multicastGroup})`'s upfront join, needed by callers (e.g. KNX discovery's
   * `setMulticast(interfaceAddress)`) whose existing protocol shape binds first and only decides
   * to join multicast once bind has actually completed. Real `dgram.Socket.addMembership()`
   * itself works exactly this way — callable any time after bind, not only at bind time. */
  joinMulticast(group: string, iface?: string): Promise<void>;
  close(): Promise<void>;
  /** Returns an unsubscribe function, matching every other listener-registration convention
   * already established in this codebase (e.g. `CasambiUdpEngine.onPacket`). */
  onMessage(cb: (msg: Buffer, rinfo: { address: string; port: number }) => void): () => void;
  onError(cb: (err: Error) => void): () => void;
  onListening(cb: () => void): () => void;
  /** Real local bind address/port once bound, or `null` before bind — never fabricated. */
  address(): { address: string; port: number } | null;
}

/** A factory a caller supplies (or omits, to get the default remote-over-NATS implementation)
 * — mirrors the `SomethingSocketFactory` convention already used by every existing injectable
 * socket in this codebase, so callers/tests can inject a fake `UdpTransport` the same way. */
export type UdpTransportFactory = () => UdpTransport;
