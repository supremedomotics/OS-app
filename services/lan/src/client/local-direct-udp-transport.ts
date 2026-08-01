import { randomUUID } from "node:crypto";
import { DgramUdpSession, defaultDgramSocket, type DgramSocketFactory } from "../server/dgram-udp-session.js";
import type { UdpBindOptions, UdpTransport } from "../transport.js";

/**
 * A same-process `UdpTransport` — real `node:dgram`, no NATS hop at all (§ Production
 * Architecture Refactor — LAN Transport Phase 2). For single-process deployments where no real
 * NATS is configured (local dev without the full Docker Compose stack), a driver still needs
 * SOME working `UdpTransport` — going through `NatsUdpTransportClient` would be pointless
 * indirection when there's no separate `supreme-lan` process to reach. This reuses the exact same
 * `DgramUdpSession` `supreme-lan`'s own server uses internally (real socket lifecycle, counters,
 * multicast join, error tracking — nothing reimplemented a third time), just exposed directly as
 * a `UdpTransport` instead of dispatched to over NATS.
 *
 * This is a real, protocol-agnostic capability — any current or future LAN driver (Casambi, KNX,
 * mDNS, SSDP, …) can use it the same way, not something built for Casambi specifically. The
 * choice between this and `NatsUdpTransportClient` is made once, centrally, by whoever wires up a
 * driver's `UdpTransportFactory` (see `services/gateway/src/installer-context.ts`'s
 * `nativeDriverContext()`), based on whether real NATS is actually configured — never a per-driver
 * decision.
 */
export class LocalDirectUdpTransport implements UdpTransport {
  private readonly session: DgramUdpSession;
  private readonly listeningListeners = new Set<() => void>();

  constructor(socketFactory: DgramSocketFactory = defaultDgramSocket) {
    this.session = new DgramUdpSession(randomUUID(), socketFactory);
  }

  async bind(opts: UdpBindOptions = {}): Promise<void> {
    await this.session.bind(opts);
    for (const l of this.listeningListeners) l();
  }

  async send(data: Buffer, port: number, address: string): Promise<void> {
    await this.session.send(data, port, address);
  }

  async joinMulticast(group: string, iface?: string): Promise<void> {
    await this.session.joinMulticast(group, iface);
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  onMessage(cb: (msg: Buffer, rinfo: { address: string; port: number }) => void): () => void {
    return this.session.onMessage(cb);
  }
  onError(cb: (err: Error) => void): () => void {
    return this.session.onError(cb);
  }
  onListening(cb: () => void): () => void {
    this.listeningListeners.add(cb);
    return () => this.listeningListeners.delete(cb);
  }
  address(): { address: string; port: number } | null {
    const address = this.session.localAddress;
    const port = this.session.localPort;
    return address !== null && port !== null ? { address, port } : null;
  }

  /** Real, non-fabricated pass-through counters — useful for a driver's own diagnostics (e.g.
   * Casambi's "Transport Monitor") when it knows it's holding a `LocalDirectUdpTransport`
   * specifically, without needing a round trip to a separate service that doesn't exist in this
   * mode. */
  get packetsSent(): number {
    return this.session.packetsSent;
  }
  get packetsReceived(): number {
    return this.session.packetsReceived;
  }
  get lastError(): string | null {
    return this.session.lastError;
  }
}
