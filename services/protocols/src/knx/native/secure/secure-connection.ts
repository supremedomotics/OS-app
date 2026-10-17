/**
 * Secure session over one TCP connection (§ KNX Secure — transport glue): StreamFactory ⇄ {@link KnxStreamDeframer} ⇄
 * {@link SecureSessionClient}. Single-use. Guarantees: the connection is torn down whenever the session ends (IPS §2.4.2: sessions end
 * with their TCP connection and vice versa); a framing violation closes the connection (decision D, see stream.ts); nothing but
 * secure-family frames is ever written; there is no code path that falls back to an unsecured connection.
 */
import { KnxStreamDeframer, KnxStreamError } from "./stream.js";
import { SecureSessionClient, SecureSessionError, type SecureSessionDiagnostics, type SecureSessionOptions, type SessionClosedEvent } from "./ip-session.js";
import type { KnxStreamSocket, StreamFactory } from "../transport.js";

export interface SecureConnectionOptions extends Omit<SecureSessionOptions, "send"> {
  streamFactory: StreamFactory;
  /** Upper bound for one frame on the stream (decision D; Core v2 limits not available). */
  maxFrameSize?: number;
}

export class SecureSessionConnection {
  readonly session: SecureSessionClient;
  private socket: KnxStreamSocket | null = null;
  private readonly deframer: KnxStreamDeframer;
  private settled = false;
  private resolveClosed!: (e: SessionClosedEvent) => void;
  private readonly closedPromise: Promise<SessionClosedEvent>;
  private started = false;

  constructor(private readonly o: SecureConnectionOptions) {
    this.deframer = new KnxStreamDeframer(o.maxFrameSize);
    this.closedPromise = new Promise((r) => { this.resolveClosed = r; });
    const { streamFactory: _f, maxFrameSize: _m, ...sessionOpts } = o;
    void _f; void _m;
    this.session = new SecureSessionClient({ ...sessionOpts, send: (f) => this.socket?.write(f) });
    this.session.onClosed((ev) => {
      this.settled = true;
      // IPS §2.4.2 / §2.2.3.9.2: ending statuses are unconfirmed — the TCP connection is closed right away.
      if (ev.reason === "local_close" || ev.reason === "server_close" || ev.reason === "server_timeout") this.socket?.end(); else this.socket?.destroy();
      this.socket = null;
      this.resolveClosed(ev);
    });
  }

  /** Resolves once the session is authenticated; rejects with a {@link SecureSessionError} (code = close reason) otherwise. */
  async connect(): Promise<void> {
    if (this.started) throw new SecureSessionError("already_started", "single-use");
    this.session.assertConfigured();   // fail closed BEFORE any TCP connection is opened
    this.started = true;
    const auth = new Promise<void>((resolve, reject) => {
      this.session.onAuthenticated(() => resolve());
      this.session.onClosed((ev) => reject(new SecureSessionError(ev.reason, `secure session ended before authentication: ${ev.reason}${ev.status !== undefined ? ` (status ${ev.status})` : ""}`)));
    });
    auth.catch(() => undefined); // avoid unhandled rejection if nobody awaits after an early failure
    try {
      this.socket = await this.o.streamFactory({
        onData: (d) => this.onData(d),
        onClose: () => { this.session.transportClosed(); },
      });
    } catch (e) {
      this.session.close("transport_closed");
      throw new SecureSessionError("transport_closed", `cannot open TCP connection: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (this.settled) { this.socket?.destroy(); this.socket = null; return auth; }
    try { this.session.start(); } catch (e) {
      // start() refuses (e.g. a reused key pair): nothing was sent, but the TCP connection is already open — release it.
      this.session.close("local_close");
      throw e;
    }
    return auth;
  }

  private onData(d: Buffer): void {
    let frames: Buffer[];
    try { frames = this.deframer.push(d); } catch (e) {
      if (e instanceof KnxStreamError) { this.session.close("protocol_violation"); return; }
      throw e;
    }
    for (const f of frames) this.session.receive(f);
  }

  sendInner(frame: Buffer): void { this.session.sendInner(frame); }
  onInner(fn: (f: Buffer) => void): () => void { return this.session.onInner(fn); }
  close(): void { this.session.close("local_close"); }
  whenClosed(): Promise<SessionClosedEvent> { return this.closedPromise; }
  diagnostics(): SecureSessionDiagnostics { return this.session.diagnostics(); }
}
