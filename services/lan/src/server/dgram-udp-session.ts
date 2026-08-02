import dgram from "node:dgram";
import type { LanUdpBindOptions } from "../shared/wire-types.js";

/**
 * Minimal surface of `node:dgram`'s `Socket` this module depends on — the same injectable-socket
 * convention already used by every other raw-socket module in this codebase (`CasambiUdpEngine`'s
 * `CasambiUdpSocketLike`, `knx-discovery.ts`'s `KnxDiscoverySocket`, `mdns.ts`'s `MdnsSocket`,
 * `ssdp.ts`'s `SsdpSocket`) so this real implementation stays fully unit-testable without opening
 * an actual OS socket. `supreme-lan` is the one place in the whole codebase that should ever
 * construct a REAL one of these (`defaultDgramSocket`) — every driver-facing consumer talks to it
 * only through the NATS-backed `UdpTransport` client.
 */
export interface DgramSocketLike {
  bind(port?: number, address?: string): void;
  send(msg: Buffer, port: number, address: string, callback?: (error: Error | null) => void): void;
  close(callback?: () => void): void;
  address(): { address: string; port: number; family: string };
  setBroadcast(flag: boolean): void;
  addMembership(multicastAddress: string, multicastInterface?: string): void;
  setMulticastInterface?(multicastInterface: string): void;
  on(event: "message", listener: (msg: Buffer, rinfo: { address: string; port: number }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "listening", listener: () => void): unknown;
}

export type DgramSocketFactory = () => DgramSocketLike;

export function defaultDgramSocket(): DgramSocketLike {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  return {
    bind: (port, address) => sock.bind(port, address),
    send: (msg, port, address, cb) => sock.send(msg, port, address, cb),
    close: (cb) => sock.close(cb),
    address: () => sock.address(),
    setBroadcast: (flag) => sock.setBroadcast(flag),
    addMembership: (group, iface) => sock.addMembership(group, iface),
    setMulticastInterface: (iface) => sock.setMulticastInterface(iface),
    on: (event, listener) => sock.on(event, listener),
  };
}

/**
 * One real, bound UDP session — the server-side counterpart of a single Gateway-side
 * `NatsUdpTransportClient`. Owns exactly one `DgramSocketLike`; `UdpTransportServer` creates one
 * of these per `bind` command and tears it down on `close`.
 */
export class DgramUdpSession {
  private socket: DgramSocketLike | null = null;
  private _packetsSent = 0;
  private _packetsReceived = 0;
  private _lastError: string | null = null;
  private _localAddress: string | null = null;
  private _localPort: number | null = null;
  private readonly messageListeners = new Set<(msg: Buffer, rinfo: { address: string; port: number }) => void>();
  private readonly errorListeners = new Set<(err: Error) => void>();

  /** Set by `UdpTransportServer` right after a successful `bind()` — not derivable from the
   * session itself since the multicast group is a caller-supplied bind option, not socket state. */
  multicastGroup: string | null = null;

  /**
   * § LAN receive-path investigation — the counters that distinguish "joined a multicast group"
   * from "actually receives multicast", which are NOT the same thing and were previously
   * conflated into a false PASS.
   *
   * Proven experimentally on a real Docker Engine (identical code, only the container's network
   * mode differing): on a bridge network `addMembership()` SUCCEEDS — the IGMP membership is
   * accepted inside the container's own netns, no error is raised — yet zero multicast datagrams
   * are ever delivered, because the bridge does not forward multicast in from the physical LAN.
   * On host networking the identical code receives them. A diagnostic that only checks "did the
   * join succeed?" therefore reports PASS for a socket that can never receive anything, which is
   * precisely why KNX/IP discovery fails silently with no error to show an installer.
   *
   * NOTE on what is deliberately NOT tracked: a per-datagram broadcast/multicast/unicast
   * classification. `dgram`'s `rinfo` reports the SENDER's address, not the datagram's
   * DESTINATION, and Node does not surface `IP_PKTINFO`/`IPV6_RECVPKTINFO`, so the destination a
   * packet was actually addressed to is not observable here. Reporting a "Broadcast RX" vs
   * "Multicast RX" split would therefore be a guess dressed as a measurement. What IS observable
   * and genuinely diagnostic is recorded instead: whether a group was joined, and whether
   * anything at all has since arrived.
   */
  private _joinedMulticastAt: string | null = null;

  constructor(
    readonly sessionId: string,
    private readonly socketFactory: DgramSocketFactory,
  ) {}

  get packetsSent(): number {
    return this._packetsSent;
  }
  get packetsReceived(): number {
    return this._packetsReceived;
  }
  get lastError(): string | null {
    return this._lastError;
  }
  get localAddress(): string | null {
    return this._localAddress;
  }
  get localPort(): number | null {
    return this._localPort;
  }
  /** ISO timestamp of a successful multicast join, or `null` if none was attempted/succeeded. */
  get joinedMulticastAt(): string | null {
    return this._joinedMulticastAt;
  }
  /** § LAN receive-path investigation — the honest signal a bare "joined OK" cannot give: a
   * multicast group was joined, yet nothing has EVER been received on this socket. On Docker
   * bridge networking that is the expected, silent failure mode (join succeeds, delivery never
   * happens). Callers surface this as WAITING/FAIL, never PASS. */
  get joinedMulticastButNeverReceived(): boolean {
    return this._joinedMulticastAt !== null && this._packetsReceived === 0;
  }

  async bind(opts: LanUdpBindOptions): Promise<{ address: string; port: number }> {
    const socket = this.socketFactory();
    socket.on("message", (msg, rinfo) => {
      this._packetsReceived += 1;
      for (const l of this.messageListeners) l(msg, rinfo);
    });
    socket.on("error", (err) => {
      this._lastError = err.message;
      for (const l of this.errorListeners) l(err);
    });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      socket.on("listening", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      socket.bind(opts.localPort, opts.localAddress);
    });

    if (opts.broadcast) socket.setBroadcast(true);
    if (opts.multicastGroup) {
      // Outgoing-interface hint before joining — the same real-world fix `knx-discovery.ts`'s
      // `setMulticast(interfaceAddress)` already documents: without it, a multi-homed host's OS
      // picks which NIC actually carries the membership independently of the bind address.
      if (opts.multicastInterface) socket.setMulticastInterface?.(opts.multicastInterface);
      socket.addMembership(opts.multicastGroup, opts.multicastInterface);
      // Records that the join SUCCEEDED — deliberately not treated as evidence of reception.
      this._joinedMulticastAt = new Date().toISOString();
    }

    const addr = socket.address();
    this._localAddress = addr.address;
    this._localPort = addr.port;
    return addr;
  }

  async joinMulticast(group: string, iface?: string): Promise<void> {
    if (!this.socket) throw new Error("supreme-lan: joinMulticast() called before bind()");
    if (iface) this.socket.setMulticastInterface?.(iface);
    this.socket.addMembership(group, iface);
    this.multicastGroup = group;
    this._joinedMulticastAt = new Date().toISOString();
  }

  async send(data: Buffer, port: number, address: string): Promise<void> {
    if (!this.socket) throw new Error("supreme-lan: send() called before bind()");
    const socket = this.socket;
    await new Promise<void>((resolve, reject) => {
      socket.send(data, port, address, (err) => (err ? reject(err) : resolve()));
    });
    this._packetsSent += 1;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  onMessage(cb: (msg: Buffer, rinfo: { address: string; port: number }) => void): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }
  onError(cb: (err: Error) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }
}
