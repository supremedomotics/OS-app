/**
 * TunnelLink over an authenticated KNX IP Secure session (§ KNX Secure — tunnelling architecture, T2). Thin adapter: whole inner frames in/out of
 * SecureSessionConnection (IPS §2.4.1: all traffic of connections inside a session is wrapped; §2.4.2: session and TCP connection end together).
 * It adds no protocol behaviour and no plaintext path. Whether it may be used with unverified tunnel rules is decided by the tunnel client from
 * {@link TunnelLink.simulated}, which is derived from the stream factory — never from a caller-supplied flag.
 */
import { SecureSessionConnection, type SecureConnectionOptions } from "./secure-connection.js";
import { isSimulated } from "../transport.js";
import type { TunnelLink, TunnelLinkHandlers } from "../tunnel-link.js";

export class SecureStreamTunnelLink implements TunnelLink {
  readonly kind = "secure-stream" as const;
  readonly simulated: boolean;
  private conn: SecureSessionConnection | null = null;
  private closedByUs = false;
  private finalDiagnostics: ReturnType<SecureSessionConnection["diagnostics"]> | null = null;

  constructor(private readonly opts: SecureConnectionOptions) {
    this.simulated = isSimulated(opts.streamFactory);
  }

  async open(h: TunnelLinkHandlers): Promise<void> {
    const conn = new SecureSessionConnection(this.opts);
    this.conn = conn;
    conn.onInner((f) => h.onFrame(f));
    void conn.whenClosed().then((ev) => { if (!this.closedByUs) h.onClosed?.(`secure session closed: ${ev.reason}${ev.status !== undefined ? ` (status ${ev.status})` : ""}`); });
    await conn.connect();   // rejects with SecureSessionError on any handshake/transport failure; nothing is sent in the clear
  }

  /** Counters and state of the underlying secure session (never secrets); null before open, the final snapshot after close. */
  sessionDiagnostics() { return this.conn?.diagnostics() ?? this.finalDiagnostics; }

  send(frame: Buffer): void { this.conn?.sendInner(frame); }

  routeBack(): void { /* the peer is the session; there is no per-frame addressing */ }

  close(): void {
    this.closedByUs = true;
    this.conn?.close();
    this.finalDiagnostics = this.conn?.diagnostics() ?? this.finalDiagnostics;
    this.conn = null;
  }
}
