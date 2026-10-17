/**
 * SIMULATION INFRASTRUCTURE — a KNX IP Secure SERVER (unicast sessions over virtual TCP), implementing the server half of
 * 03_08_09 KNX IP Secure v01.01.02 §2.2.3.5.2 (session state machine), §2.2.3.6–9 and §2.4. It is a MODEL used to exercise the
 * native client; passing tests against it is not interoperability with real devices.
 *
 * Fault switches let tests reproduce hostile or broken servers: wrong device authentication code, duplicate/zero session ids,
 * reuse of the server key pair, silence, replayed counters.
 */
import { KnxStreamDeframer, KnxStreamError } from "../secure/stream.js";
import {
  decodeSessionRequest, decodeSessionStatus, encodeSecureWrapper, encodeSessionResponse, encodeSessionStatus, KnxSecureFrameError, openSecureWrapper, parseSecureWrapper,
  parseSessionAuthenticate, peekSecureService, SecureService, SessionStatus, verifySessionAuthenticate,
} from "../secure/ip-frames.js";
import { deriveSessionKey, generateEcdhKeyPair, type EcdhKeyPair } from "../secure/ip-keys.js";
import { Secret } from "../security/secret.js";
import type { Clock, TimerHandle } from "../transport.js";
import type { ServerSide, VirtualStreamNetwork } from "./virtual-stream.js";

export interface VirtualSecureGatewayOptions {
  address: string;
  port?: number;
  /** Device Authentication Code the server proves knowledge of (SESSION_RESPONSE MAC key). */
  deviceAuthCode: Secret;
  /** User id → password hash. Absent id = "no password hash assigned" → authentication fails (§2.4.1). */
  users: Map<number, Secret>;
  serialNumber: Buffer;
  maxSessions?: number;
  /** §2.2.3.5.2.1.1 */
  authenticationTimeoutMs?: number;
  sessionTimeoutMs?: number;
  /** Called with every authenticated inner frame (e.g. CONNECT_REQUEST, TUNNELLING_REQUEST). */
  onInner?: (session: ServerSession, frame: Buffer) => void;
}

export interface SecureGatewayFaults {
  /** Compute the SESSION_RESPONSE MAC with a different key (impostor server). */
  wrongDeviceAuthCode: boolean;
  /** Send session id 0000h (reserved for multicast). */
  sessionIdZero: boolean;
  /** Reply with Y = X. */
  echoClientPublic: boolean;
  /** Reply with an all-zero public value. */
  zeroPublic: boolean;
  /** Never answer SESSION_REQUEST. */
  silent: boolean;
  /** Reuse one server key pair for every session (violates §2.2.3.1.1). */
  reuseKeyPair: boolean;
}

export type ServerSessionState = "unauthenticated" | "authenticated" | "closed";

export class ServerSession {
  state: ServerSessionState = "unauthenticated";
  userId: number | null = null;
  key: Secret | null = null;
  sendSeq = 0n;
  lastRecv: bigint | null = null;
  clientPublic: Buffer | null = null;
  serverKeyPair: EcdhKeyPair | null = null;
  timer: TimerHandle | null = null;
  constructor(readonly id: number, readonly conn: ServerSide) {}
}

export class VirtualSecureGateway {
  readonly faults: SecureGatewayFaults = { wrongDeviceAuthCode: false, sessionIdZero: false, echoClientPublic: false, zeroPublic: false, silent: false, reuseKeyPair: false };
  readonly sessions = new Map<number, ServerSession>();
  readonly counters = { requests: 0, authenticated: 0, authFailures: 0, malformed: 0, replayDrops: 0, macDrops: 0, nestedDrops: 0, plainDrops: 0, keepAlives: 0, timeouts: 0, closedByClient: 0 };
  private nextId = 1;
  private sharedPair: EcdhKeyPair | null = null;
  private detach: (() => void) | null;
  private readonly cfg: Required<Pick<VirtualSecureGatewayOptions, "maxSessions" | "authenticationTimeoutMs" | "sessionTimeoutMs">>;

  constructor(private readonly net: VirtualStreamNetwork, private readonly clock: Clock, private readonly o: VirtualSecureGatewayOptions) {
    this.cfg = { maxSessions: o.maxSessions ?? 4, authenticationTimeoutMs: o.authenticationTimeoutMs ?? 10_000, sessionTimeoutMs: o.sessionTimeoutMs ?? 60_000 };
    this.detach = net.listen(o.address, o.port ?? 3671, (c) => this.accept(c));
  }

  shutdown(): void {
    for (const s of [...this.sessions.values()]) this.drop(s);
    this.detach?.(); this.detach = null;
  }

  /** Sends an authenticated inner frame to the client of `s` (server counter starts at 0, +1 per frame). */
  sendInner(s: ServerSession, inner: Buffer): void {
    if (!s.key) throw new Error("session has no key");
    const f = encodeSecureWrapper({ sessionId: s.id, sequence: s.sendSeq, serial: this.o.serialNumber, tag: Buffer.alloc(2), inner, key: s.key });
    s.sendSeq += 1n;
    s.conn.write(f);
  }

  /** Terminal status to the client (wrapped), then close the session and the TCP connection. */
  endWith(s: ServerSession, status: number): void {
    if (s.key) this.sendInner(s, encodeSessionStatus(status));
    this.drop(s);
    s.conn.end();
  }

  private accept(conn: ServerSide): void {
    const deframer = new KnxStreamDeframer();
    let session: ServerSession | null = null;
    conn.onData((chunk) => {
      let frames: Buffer[];
      try { frames = deframer.push(chunk); } catch (e) { if (e instanceof KnxStreamError) { this.counters.malformed++; if (session) this.drop(session); conn.destroy(); return; } throw e; }
      for (const f of frames) session = this.handle(conn, session, f);
    });
    conn.onClose(() => { if (session) this.drop(session); });
  }

  private handle(conn: ServerSide, session: ServerSession | null, frame: Buffer): ServerSession | null {
    const svc = peekSecureService(frame);
    try {
      if (svc === SecureService.SESSION_REQUEST) return this.onRequest(conn, session, frame);
      if (svc === SecureService.SECURE_WRAPPER && session) { this.onWrapper(session, frame); return session; }
      this.counters.plainDrops++;                   // plain frames for a secured service are not processed
    } catch (e) { if (e instanceof KnxSecureFrameError) { this.counters.malformed++; return session; } throw e; }
    return session;
  }

  private onRequest(conn: ServerSide, existing: ServerSession | null, frame: Buffer): ServerSession | null {
    this.counters.requests++;
    if (this.faults.silent) return existing;
    const { clientPublic } = decodeSessionRequest(frame);
    if (existing) return existing;                                       // one session per request in this model
    if (this.sessions.size >= this.cfg.maxSessions) return null;         // §2.2.3.7.6: no resources → discard, no response
    const id = this.faults.sessionIdZero ? 0 : this.allocateId();
    const kp = this.faults.reuseKeyPair ? (this.sharedPair ??= generateEcdhKeyPair()) : generateEcdhKeyPair();
    const s = new ServerSession(id, conn);
    s.clientPublic = clientPublic; s.serverKeyPair = kp;
    s.key = deriveSessionKey(kp.privateKey, clientPublic);
    this.sessions.set(id || -conn.remote.port, s);                       // id 0 would collide; key by port for the faulty case
    let serverPublic = kp.publicKey;
    if (this.faults.echoClientPublic) serverPublic = clientPublic;
    if (this.faults.zeroPublic) serverPublic = Buffer.alloc(32);
    const dac = this.faults.wrongDeviceAuthCode ? new Secret(Buffer.alloc(16, 0xee)) : this.o.deviceAuthCode;
    conn.write(encodeSessionResponse({ sessionId: id, serverPublic, clientPublic, deviceAuthCode: dac }));
    s.timer = this.clock.setTimeout(() => { this.counters.timeouts++; this.endWith(s, SessionStatus.TIMEOUT); }, this.cfg.authenticationTimeoutMs);  // A5
    return s;
  }

  private allocateId(): number {
    for (let tries = 0; tries < 0xffff; tries++) { const id = this.nextId; this.nextId = this.nextId >= 0xffff ? 1 : this.nextId + 1; if (!this.sessions.has(id)) return id; }
    throw new Error("no free session id");
  }

  private onWrapper(s: ServerSession, frame: Buffer): void {
    if (s.state === "closed" || !s.key) return;
    const p = parseSecureWrapper(frame);
    if (p.sessionId !== s.id) return;                                    // another session's id → ignored
    if (s.lastRecv !== null && p.sequence <= s.lastRecv) { this.counters.replayDrops++; return; }
    const inner = openSecureWrapper(p, s.key);
    if (inner === null) { this.counters.macDrops++; return; }            // invalid wrapper → ignored (§2.4.1)
    s.lastRecv = p.sequence;
    const svc = peekSecureService(inner);
    if (s.state === "unauthenticated") {
      if (svc !== SecureService.SESSION_AUTHENTICATE) { this.endWith(s, SessionStatus.UNAUTHENTICATED); return; }   // A6
      const auth = parseSessionAuthenticate(inner);
      const hash = this.o.users.get(auth.userId);
      if (!hash || !verifySessionAuthenticate(auth, s.clientPublic!, s.serverKeyPair!.publicKey, hash)) { this.counters.authFailures++; this.endWith(s, SessionStatus.AUTHENTICATION_FAILED); return; } // A2
      s.state = "authenticated"; s.userId = auth.userId; this.counters.authenticated++;
      this.sendInner(s, encodeSessionStatus(SessionStatus.AUTHENTICATION_SUCCESS));                                   // A1
      this.restartSessionTimer(s);
      return;
    }
    if (svc === SecureService.SESSION_STATUS) {
      const st = decodeSessionStatus(inner);
      if (st === SessionStatus.CLOSE) { this.counters.closedByClient++; this.drop(s); s.conn.end(); return; }          // A3
      if (st === SessionStatus.KEEPALIVE) { this.counters.keepAlives++; this.restartSessionTimer(s); return; }        // A4
      return;
    }
    if (svc !== null) { this.counters.nestedDrops++; return; }
    this.restartSessionTimer(s);                                                                                        // A4 on any valid frame
    this.o.onInner?.(s, inner);
  }

  private restartSessionTimer(s: ServerSession): void {
    if (s.timer) this.clock.clearTimeout(s.timer);
    s.timer = this.clock.setTimeout(() => { this.counters.timeouts++; this.endWith(s, SessionStatus.TIMEOUT); }, this.cfg.sessionTimeoutMs);  // A5
  }

  private drop(s: ServerSession): void {
    if (s.state === "closed") return;
    s.state = "closed";
    if (s.timer) this.clock.clearTimeout(s.timer);
    s.key?.wipe(); s.key = null;
    for (const [k, v] of this.sessions) if (v === s) this.sessions.delete(k);
  }
}
