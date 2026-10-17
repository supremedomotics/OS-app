/**
 * KNX IP Secure CLIENT session (§ KNX Secure — IP layer). Pure state machine: no sockets, no timers of its own (an injected
 * {@link Clock} drives it), frames in via {@link SecureSessionClient.receive}, frames out via the injected `send`.
 *
 * Normative source: 03_08_09 KNX IP Secure v01.01.02 AS — §2.2.3.5 (session/identifiers), §2.2.3.3 (replay protection),
 * §2.2.3.6–9 (frames), §2.4.1–2.4.2 (handshake, closing). The server-side state machine of §2.2.3.5.2 is the spec's own model; the CLIENT
 * behaviour below follows the client-addressed sentences of those clauses and is annotated per rule. Nothing here is hardware-validated.
 *
 * Fail-closed decisions (D) that go beyond what the text strictly requires:
 *   D1  The server MUST prove knowledge of the Device Authentication Code (MAC of SESSION_RESPONSE). The text calls this "optional" for
 *       the client (§2.2.3.7.5); SupremeOS requires it unless `allowUnauthenticatedServer` is set explicitly, and also performs the checks
 *       the conformance tool's own client procedure performs (session id ≠ 0, Y ≠ 0, Y ≠ X).
 *   D2  A session is single-use. After any failure a NEW instance (new ECDH key pair, new handshake) is required — the text forbids more
 *       than one SESSION_AUTHENTICATE per ECDH session key (§2.2.3.8.3).
 *   D3  Nothing is ever sent or delivered in the clear: plain frames received on the session are ignored and counted; there is no
 *       downgrade path. Received sequence state advances ONLY after a frame's MAC has verified.
 *   D4  A wrapper is never accepted when it itself contains a secure-family frame other than SESSION_STATUS (no nesting, §2.2.1.2.2.2).
 */
import { SecureService, SessionStatus, SEQUENCE_MAX, KnxSecureFrameError, decodeSessionStatus, encodeSecureWrapper, encodeSessionAuthenticate, encodeSessionRequest, encodeSessionStatus, openSecureWrapper, parseSecureWrapper, parseSessionResponse, peekSecureService, verifySessionResponse } from "./ip-frames.js";
import { deriveSessionKey, generateEcdhKeyPair, KnxSecureKeyError, type EcdhKeyPair } from "./ip-keys.js";
import type { Secret } from "../security/secret.js";
import type { Clock, TimerHandle } from "../transport.js";

export type SessionState = "idle" | "awaiting_response" | "awaiting_status" | "authenticated" | "closed";

export type SessionCloseReason =
  | "local_close" | "transport_closed"
  | "response_timeout" | "authentication_timeout"
  | "invalid_response" | "weak_peer_key" | "server_authentication_failed"
  | "authentication_failed" | "unauthenticated" | "server_timeout" | "server_close"
  | "sequence_exhausted" | "protocol_violation";

export class SecureSessionError extends Error {
  constructor(readonly code: SessionCloseReason | "invalid_option" | "not_authenticated" | "already_started", message: string) {
    super(message);
    this.name = "SecureSessionError";
  }
}

export interface SecureSessionOptions {
  /** Writes one complete KNXnet/IP frame to the TCP stream. */
  send(frame: Buffer): void;
  clock: Clock;
  /** User id for SESSION_AUTHENTICATE: 01h management, 02h–7Fh user (§2.2.3.8.2). */
  userId: number;
  /** PBKDF2 password hash for that user (derive with deriveUserPasswordHash); NOT wiped by the session (caller-owned). */
  passwordHash: Secret;
  /** Device Authentication Code (derive with deriveDeviceAuthenticationCode, or the FDSK for an uncommissioned device); caller-owned. */
  deviceAuthCode: Secret | null;
  /** D1: set true only to knowingly talk to an unauthenticated server. Default false. */
  allowUnauthenticatedServer?: boolean;
  /** This client's 6-octet KNX serial number for the wrapper security information (§2.2.1.3.1). No default: it must be assigned. */
  serialNumber: Buffer;
  /** Test seam: key-pair source (default: fresh CSPRNG pair, §2.2.3.1.1). */
  generateKeyPair?: () => EcdhKeyPair;
  /** §2.2.3.6.1 / §2.2.3.8.1: client waits at most 10 s for the response / authentication status. */
  responseTimeoutMs?: number;
  authenticationTimeoutMs?: number;
  /** §2.2.3.5.2.1.1: an authenticated session idle for 60 s is dropped by the server; send STATUS_KEEPALIVE well before that. */
  keepAliveIntervalMs?: number;
}

export interface SecureSessionDiagnostics {
  state: SessionState;
  sessionId: number | null;
  serverAuthenticated: boolean | null;
  framesSent: number;
  framesAccepted: number;
  discarded: {
    malformed: number; plainFrame: number; wrongSession: number; replay: number; macFailure: number; nested: number; unexpected: number; unauthenticatedState: number;
  };
  nextSendSequence: string;
  lastReceivedSequence: string | null;
  closedReason: SessionCloseReason | null;
  closedStatus: number | null;
}

export interface SessionClosedEvent { reason: SessionCloseReason; status?: number }

type L<T> = (v: T) => void;

export class SecureSessionClient {
  private state: SessionState = "idle";
  private kp: EcdhKeyPair | null = null;
  private serverPublic: Buffer | null = null;
  private sessionKey: Secret | null = null;
  private sessionId = 0;
  private sendSeq = 0n;                    // §2.2.3.3: starts at zero for every new connection
  private lastRecv: bigint | null = null;  // highest sequence number of a frame whose MAC verified
  private serverAuthenticated: boolean | null = null;
  private timer: TimerHandle | null = null;
  private kaTimer: TimerHandle | null = null;
  private closedReason: SessionCloseReason | null = null;
  private closedStatus: number | null = null;
  private framesSent = 0;
  private framesAccepted = 0;
  private readonly d = { malformed: 0, plainFrame: 0, wrongSession: 0, replay: 0, macFailure: 0, nested: 0, unexpected: 0, unauthenticatedState: 0 };
  private readonly innerL = new Set<L<Buffer>>();
  private readonly authL = new Set<L<void>>();
  private readonly closedL = new Set<L<SessionClosedEvent>>();
  private readonly cfg: Required<Pick<SecureSessionOptions, "responseTimeoutMs" | "authenticationTimeoutMs" | "keepAliveIntervalMs">>;

  constructor(private readonly o: SecureSessionOptions) {
    this.cfg = { responseTimeoutMs: o.responseTimeoutMs ?? 10_000, authenticationTimeoutMs: o.authenticationTimeoutMs ?? 10_000, keepAliveIntervalMs: o.keepAliveIntervalMs ?? 30_000 };
  }

  onInner(fn: L<Buffer>): () => void { this.innerL.add(fn); return () => { this.innerL.delete(fn); }; }
  onAuthenticated(fn: L<void>): () => void { this.authL.add(fn); return () => { this.authL.delete(fn); }; }
  onClosed(fn: L<SessionClosedEvent>): () => void { this.closedL.add(fn); return () => { this.closedL.delete(fn); }; }

  get currentState(): SessionState { return this.state; }

  diagnostics(): SecureSessionDiagnostics {
    return {
      state: this.state, sessionId: this.sessionId || null, serverAuthenticated: this.serverAuthenticated, framesSent: this.framesSent, framesAccepted: this.framesAccepted,
      discarded: { ...this.d }, nextSendSequence: this.sendSeq.toString(), lastReceivedSequence: this.lastRecv === null ? null : this.lastRecv.toString(),
      closedReason: this.closedReason, closedStatus: this.closedStatus,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------- start

  /** Validates the configuration; throws {@link SecureSessionError}("invalid_option") without side effects. Safe to call before connecting. */
  assertConfigured(): void {
    const o = this.o;
    if (!Number.isInteger(o.userId) || o.userId < 0x01 || o.userId > 0x7f) throw new SecureSessionError("invalid_option", "userId must be 01h–7Fh");
    if (o.serialNumber.length !== 6) throw new SecureSessionError("invalid_option", "serialNumber must be 6 octets and must be an assigned KNX serial number");
    if (o.passwordHash.wiped || o.passwordHash.length !== 16) throw new SecureSessionError("invalid_option", "passwordHash must be a 16-octet secret");
    if (o.deviceAuthCode === null && o.allowUnauthenticatedServer !== true) {
      throw new SecureSessionError("invalid_option", "a Device Authentication Code is required to authenticate the server; refusing to continue without it (set allowUnauthenticatedServer only knowingly)");
    }
    if (o.deviceAuthCode && (o.deviceAuthCode.wiped || o.deviceAuthCode.length !== 16)) throw new SecureSessionError("invalid_option", "deviceAuthCode must be a 16-octet secret");
  }

  /** Sends SESSION_REQUEST. Throws (and sends nothing) when the configuration cannot give a verified handshake. */
  start(): void {
    if (this.state !== "idle") throw new SecureSessionError("already_started", "a secure session is single-use (D2); create a new instance");
    const o = this.o;
    this.assertConfigured();
    this.kp = (o.generateKeyPair ?? generateEcdhKeyPair)();   // fresh pair per session, never reused (§2.2.3.1.1)
    this.transmit(encodeSessionRequest(this.kp.publicKey));
    this.state = "awaiting_response";
    this.arm(this.cfg.responseTimeoutMs, () => this.close("response_timeout"));
  }

  // ---------------------------------------------------------------------------------------------------------------- receive

  /** Feed one complete KNXnet/IP frame received on the TCP connection. Never throws; bad input is counted and dropped. */
  receive(frame: Buffer): void {
    if (this.state === "closed" || this.state === "idle") return;
    const svc = peekSecureService(frame);
    if (svc === null) { this.d.plainFrame++; return; }                      // D3: plain frames are never processed here
    try {
      if (svc === SecureService.SESSION_RESPONSE) { this.onResponse(frame); return; }
      if (svc === SecureService.SECURE_WRAPPER) { this.onWrapper(frame); return; }
      this.d.unexpected++;                                                  // REQUEST/AUTHENTICATE/TIMER_NOTIFY/STATUS in the clear
    } catch (e) {
      if (e instanceof KnxSecureFrameError) { this.d.malformed++; return; } // §2.4.1: malformed frames are ignored
      throw e;
    }
  }

  private onResponse(frame: Buffer): void {
    if (this.state !== "awaiting_response") { this.d.unexpected++; return; }
    const p = parseSessionResponse(frame);
    const X = this.kp!.publicKey;
    // session id 00h is reserved for multicast (§2.2.3.7.2); Y must be non-zero and differ from X (conformance tool's own client checks)
    if (p.sessionId === 0 || p.serverPublic.every((x) => x === 0) || p.serverPublic.equals(X)) { this.close("invalid_response"); return; }
    let key: Secret;
    try { key = deriveSessionKey(this.kp!.privateKey, p.serverPublic); } catch (e) {
      if (e instanceof KnxSecureKeyError) { this.close("weak_peer_key"); return; }
      throw e;
    }
    if (this.o.deviceAuthCode) {
      this.serverAuthenticated = verifySessionResponse(p, X, this.o.deviceAuthCode);
      if (!this.serverAuthenticated) { key.wipe(); this.close("server_authentication_failed"); return; }   // D1
    } else {
      this.serverAuthenticated = false;                                      // explicitly unauthenticated (allowUnauthenticatedServer)
    }
    this.sessionId = p.sessionId;
    this.serverPublic = p.serverPublic;
    this.sessionKey = key;
    this.clearTimer();
    // exactly ONE authenticate per ECDH session key (§2.2.3.8.3)
    const auth = encodeSessionAuthenticate({ userId: this.o.userId, clientPublic: X, serverPublic: p.serverPublic, passwordHash: this.o.passwordHash });
    this.state = "awaiting_status";
    this.sendWrapped(auth);
    this.arm(this.cfg.authenticationTimeoutMs, () => this.close("authentication_timeout"));
  }

  private onWrapper(frame: Buffer): void {
    if (this.state !== "awaiting_status" && this.state !== "authenticated") { this.d.unauthenticatedState++; return; }
    const p = parseSecureWrapper(frame);
    if (p.sessionId !== this.sessionId) { this.d.wrongSession++; return; }  // other/unknown session id → discard (§2.2.1.3.3)
    // §2.2.3.3 / §2.2.1.3.3: discard sequence numbers <= the stored one (checked before the MAC is allowed for unicast)
    if (this.lastRecv !== null && p.sequence <= this.lastRecv) { this.d.replay++; return; }
    const inner = openSecureWrapper(p, this.sessionKey!);
    if (inner === null) { this.d.macFailure++; return; }                    // D3: state does NOT advance on a failed MAC
    this.lastRecv = p.sequence;
    this.framesAccepted++;
    this.afterAuthenticFrame(inner);
  }

  private afterAuthenticFrame(inner: Buffer): void {
    const svc = peekSecureService(inner);
    if (svc === SecureService.SESSION_STATUS) {
      let status: number;
      try { status = decodeSessionStatus(inner); } catch { this.d.malformed++; return; }
      this.onStatus(status);
      return;
    }
    if (svc !== null) { this.d.nested++; return; }                          // D4: no nested/other secure-family frames
    if (this.state !== "authenticated") { this.d.unauthenticatedState++; return; }   // only SESSION_STATUS is meaningful before success
    for (const l of [...this.innerL]) { try { l(inner); } catch { /* subscriber faults never affect the session */ } }
  }

  private onStatus(status: number): void {
    if (this.state === "awaiting_status") {
      if (status === SessionStatus.AUTHENTICATION_SUCCESS) {
        this.clearTimer();
        this.state = "authenticated";
        this.scheduleKeepAlive();
        for (const l of [...this.authL]) { try { l(); } catch { /* ignore */ } }
        return;
      }
    } else if (status === SessionStatus.AUTHENTICATION_SUCCESS) { this.d.unexpected++; return; }
    // Terminal statuses sent by the server (§2.2.3.9.2); they are unconfirmed — we simply end the session.
    const map: Partial<Record<number, SessionCloseReason>> = {
      [SessionStatus.AUTHENTICATION_FAILED]: "authentication_failed", [SessionStatus.UNAUTHENTICATED]: "unauthenticated",
      [SessionStatus.TIMEOUT]: "server_timeout", [SessionStatus.CLOSE]: "server_close",
    };
    const reason = map[status];
    if (reason) this.close(reason, status);
    else this.d.unexpected++;                                               // KEEPALIVE is client-only usage; unknown codes ignored
  }

  // ---------------------------------------------------------------------------------------------------------------- send

  /** Wraps and sends one KNXnet/IP frame (e.g. CONNECT_REQUEST, TUNNELLING_REQUEST) inside the authenticated session. */
  sendInner(frame: Buffer): void {
    if (this.state !== "authenticated") throw new SecureSessionError("not_authenticated", `cannot send in state "${this.state}"`);
    if (peekSecureService(frame) !== null) throw new SecureSessionError("protocol_violation", "secure-family frames cannot be nested inside a wrapper (§2.2.1.2.2.2)");
    this.sendWrapped(frame);
    this.scheduleKeepAlive();
  }

  private sendWrapped(inner: Buffer): void {
    if (this.sendSeq > SEQUENCE_MAX) { this.close("sequence_exhausted"); throw new SecureSessionError("sequence_exhausted", "48-bit send counter exhausted; the counter must never wrap"); }
    const f = encodeSecureWrapper({ sessionId: this.sessionId, sequence: this.sendSeq, serial: this.o.serialNumber, tag: Buffer.alloc(2), inner, key: this.sessionKey! });
    this.sendSeq += 1n;
    this.transmit(f);
  }

  private transmit(f: Buffer): void { this.framesSent++; this.o.send(f); }

  /** TEST ONLY: positions the send counter (e.g. just below 2^48) to exercise exhaustion. Never call from production code. */
  unsafeSetSendSequenceForTest(n: bigint): void { this.sendSeq = n; }

  // ---------------------------------------------------------------------------------------------------------------- lifecycle

  private scheduleKeepAlive(): void {
    if (this.kaTimer) this.o.clock.clearTimeout(this.kaTimer);
    this.kaTimer = this.o.clock.setTimeout(() => {
      this.kaTimer = null;
      if (this.state !== "authenticated") return;
      try { this.sendWrapped(encodeSessionStatus(SessionStatus.KEEPALIVE)); } catch { return; }
      this.scheduleKeepAlive();
    }, this.cfg.keepAliveIntervalMs);
  }

  /** Orderly local close: STATUS_CLOSE (unconfirmed) when a session exists, then release everything. */
  close(reason: SessionCloseReason = "local_close", status?: number): void {
    if (this.state === "closed") return;
    if (reason === "local_close" && (this.state === "authenticated" || this.state === "awaiting_status") && this.sessionKey) {
      try { this.sendWrapped(encodeSessionStatus(SessionStatus.CLOSE)); } catch { /* best effort */ }
    }
    this.state = "closed";
    this.closedReason = reason;
    this.closedStatus = status ?? null;
    this.clearTimer();
    if (this.kaTimer) { this.o.clock.clearTimeout(this.kaTimer); this.kaTimer = null; }
    this.sessionKey?.wipe(); this.sessionKey = null;
    this.kp?.privateKey.wipe(); this.kp = null;
    this.serverPublic = null;
    const ev: SessionClosedEvent = status === undefined ? { reason } : { reason, status };
    for (const l of [...this.closedL]) { try { l(ev); } catch { /* ignore */ } }
    this.innerL.clear(); this.authL.clear(); this.closedL.clear();
  }

  /** The TCP connection ended: the session ends with it (§2.4.2). */
  transportClosed(): void { this.close("transport_closed"); }

  private arm(ms: number, fn: () => void): void { this.clearTimer(); this.timer = this.o.clock.setTimeout(fn, ms); }
  private clearTimer(): void { if (this.timer) { this.o.clock.clearTimeout(this.timer); this.timer = null; } }
}
