/**
 * Transport seam of the classic tunnelling client (§ KNX Secure — tunnelling architecture, stage T1). The client's protocol logic
 * (CONNECT/ACK/heartbeat/sequence/teardown) is written against {@link TunnelLink}; {@link UdpTunnelLink} carries today's UDP behaviour
 * VERBATIM (socket ownership, source filtering, route-back addressing), moved out of tunnel-client.ts without change.
 *
 * `datagram` keeps today's UDP semantics. `secure-stream` (secure/secure-stream-link.ts) selects the TCP rules of tunnel-rules.ts: three are
 * verified (TUN §2.6.2), the rest are blocked (docs/architecture/knx-secure-blocker-matrix.md B1–B5, B8), so a stream link only works over an
 * in-memory transport.
 */
import type { RemoteInfo, SocketFactory, KnxDatagramSocket } from "./transport.js";

export interface TunnelLinkHandlers {
  /** One complete frame from the gateway. */
  onFrame(data: Buffer): void;
  /** A datagram from any other source address was dropped (counted by the client). */
  onForeign(): void;
  onError(error: Error): void;
  /** The link ended by itself (e.g. the secure session closed). Never called by the UDP link. */
  onClosed?(reason: string): void;
}

export interface TunnelLink {
  /** `datagram` = UDP rules (per-frame ACK, retransmission, UDP route-back HPAI). `secure-stream` = TCP rules of tunnel-rules.ts. */
  readonly kind: "datagram" | "secure-stream";
  /** Stream links only: true when the transport is in-memory (see markSimulated); unverified stream rules are allowed only then. */
  readonly simulated?: boolean;
  /** Opens the transport; rejects if it cannot be opened. */
  open(handlers: TunnelLinkHandlers): Promise<void>;
  /** Sends to the current peer: the gateway's configured endpoint until {@link routeBack} has run. No-op when not open. */
  send(frame: Buffer): void;
  /** CONNECT_RESPONSE accepted: from now on address the peer the response came from (or its announced data endpoint, see below). */
  routeBack(announced: { address: string; port: number } | undefined): void;
  /** Releases the transport. Idempotent; safe before open. After close no handler is invoked. */
  close(): void;
}

export class UdpTunnelLink implements TunnelLink {
  readonly kind = "datagram" as const;
  private socket: KnxDatagramSocket | null = null;
  private lastFrom: RemoteInfo | null = null;
  private target: RemoteInfo | null = null;

  constructor(private readonly host: string, private readonly port: number, private readonly socketFactory: SocketFactory) {}

  async open(h: TunnelLinkHandlers): Promise<void> {
    this.socket = await this.socketFactory({
      onMessage: (data, from) => {
        if (from.address !== this.host) { h.onForeign(); return; }
        this.lastFrom = from;
        h.onFrame(data);
      },
      onError: (err) => h.onError(err),
    });
  }

  send(frame: Buffer): void {
    if (!this.socket) return;
    const to = this.target ?? { address: this.host, port: this.port };
    this.socket.send(frame, to.port, to.address);
  }

  routeBack(announced: { address: string; port: number } | undefined): void {
    const from = this.lastFrom ?? { address: this.host, port: this.port };
    // Route-back mode: all further traffic goes to where the response came from.
    // Use the announced data endpoint only when it is concrete and on the gateway's own address;
    // a zero/foreign endpoint (NAT, or a gateway reporting an internal IP) means "answer where
    // you heard from". Hardware validation of multi-port gateways is still outstanding.
    const useAnnounced = announced !== undefined && announced.port !== 0 && announced.address === this.host;
    this.target = { address: from.address, port: useAnnounced ? announced.port : from.port };
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
