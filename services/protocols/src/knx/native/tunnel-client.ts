/**
 * KNXnet/IP tunnelling session client (§ Clean-room KNX stack — session layer). Implements
 * the connection-oriented tunnelling procedures from the published KNXnet/IP Core and
 * Tunnelling specifications on top of the pure codecs in this directory:
 *
 *   - CONNECT / CONNECTIONSTATE (heartbeat) / DISCONNECT with the spec's timeouts
 *   - one-outstanding-frame TUNNELLING_REQUEST flow with ACK wait, single retry, then
 *     session termination (the spec's "tunnel is considered lost")
 *   - inbound sequence handling: in-order → ACK + deliver, repeat of the previous → ACK
 *     only (never delivered twice), anything else → ignored
 *
 * A client instance is SINGLE-USE: it goes idle → connecting → connected → closed once.
 * Reconnection is the supervisor's job and always builds a fresh instance, so no timer,
 * socket or listener can ever be carried across sessions (bounded resources by
 * construction). Every outcome is reported through typed errors/events and counters —
 * nothing is swallowed.
 *
 * Distinguishes two different facts the troubleshooting engine needs:
 *   - the tunnel ACK       : the gateway accepted the frame (promise from {@link sendGroup})
 *   - the L_Data.con       : the frame was actually put on the bus (`receipt.confirmation`)
 */

import { decodeCemi, encodeGroupCemi, KnxCemiError, CemiMessageCode, type CemiFrame, type GroupData, type GroupService, type Priority } from "./cemi.js";
import {
  decodeConnectResponse, decodeConnectionStateResponse, decodeDisconnectRequest, decodeDisconnectResponse, decodeFrame,
  decodeTunnellingAck, decodeTunnellingRequest, describeStatus, encodeConnectRequest, encodeConnectionStateRequest,
  encodeDisconnectRequest, encodeDisconnectResponse, encodeTunnellingAck, encodeTunnellingRequest, KnxFrameError,
  NAT_HPAI, ServiceType, StatusCode, TunnelLayer,
} from "./knxnetip-frame.js";
import { assertPolicySatisfiable, PLAIN_POLICY, type SecurityPolicy } from "./security/policy.js";
import { STREAM_RULES, unverifiedBlockers } from "./tunnel-rules.js";
import { UdpTunnelLink, type TunnelLink } from "./tunnel-link.js";
import { systemClock, type Clock, type SocketFactory, type TimerHandle } from "./transport.js";

export type TunnelErrorCode =
  | "invalid_argument" | "not_connected" | "connect_timeout" | "connect_rejected" | "socket_error"
  | "heartbeat_lost" | "ack_timeout" | "ack_error" | "gateway_disconnect" | "queue_full" | "closed" | "session_closed";

export class KnxTunnelError extends Error {
  constructor(readonly code: TunnelErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "KnxTunnelError";
  }
}

export type TunnelState = "idle" | "connecting" | "connected" | "disconnecting" | "closed";
export type CloseReason = TunnelErrorCode | "local_disconnect";

export interface TunnelClientOptions {
  /** Gateway IPv4 literal (discovery returns addresses; no DNS inside the protocol layer). */
  host: string;
  port?: number;
  /** UDP socket source (the usual case). Required unless `link` is given. */
  socketFactory?: SocketFactory;
  /** Transport seam; defaults to {@link UdpTunnelLink} over `socketFactory`. Datagram semantics only (see tunnel-link.ts). */
  link?: TunnelLink;
  clock?: Clock;
  layer?: number;
  /** Spec defaults: connect 10 s, ack 1 s (+1 retry), heartbeat 60 s / 10 s response / 3 tries,
   * disconnect 5 s. */
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
  maxSendAttempts?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  heartbeatMaxFailures?: number;
  disconnectTimeoutMs?: number;
  /** How long to wait for the bus-level L_Data.con after the tunnel ACK. */
  confirmationTimeoutMs?: number;
  maxQueuedSends?: number;
  maxPendingConfirmations?: number;
  /** Declared security requirement. Anything other than plain makes construction FAIL
   * (secure modes are not implemented) — there is no downgrade path. */
  security?: SecurityPolicy;
}

export interface SendInput {
  destination: number;
  service: GroupService;
  data?: GroupData | null;
  priority?: Priority;
}

export type ConfirmationOutcome = "confirmed" | "bus_error" | "not_confirmed";

export type SendReceipt = (
  | {
    transportAck: "ack";
    ackedAt: number;
    /** Time from first transmission to ACK (ms) — gateway responsiveness. */
    ackLatencyMs: number;
  }
  | {
    /** Stream mode (TUN §2.6.2): there is no TUNNELLING_ACK, so there is no ACK time — the frame was handed to the secure session. */
    transportAck: "none";
    ackedAt: null;
    ackLatencyMs: null;
  }
) & {
  /** Tunnel sequence number used (UDP: the one the gateway acknowledged; stream: always 0). */
  sequence: number;
  attempts: number;
  /** Never rejects. `confirmed` = L_Data.con without error; `bus_error` = L_Data.con with the
   * error flag; `not_confirmed` = no matching L_Data.con arrived in time (or session ended). */
  confirmation: Promise<ConfirmationOutcome>;
};

export interface TunnelDiagnostics {
  state: TunnelState;
  link: "datagram" | "secure-stream";
  /** TUNNELLING_ACK frames received and ignored in stream mode (TUN §2.6.2). */
  ignoredAcks: number;
  channelId: number | null;
  assignedAddress: number | null;
  gateway: string;
  connectLatencyMs: number | null;
  heartbeat: { sent: number; failures: number; lastRttMs: number | null; lastOkAt: number | null };
  framesSent: number;
  framesReceived: number;
  telegramsDelivered: number;
  acksReceived: number;
  sendRetries: number;
  staleAcks: number;
  duplicateInbound: number;
  outOfOrderInbound: number;
  foreignDatagrams: number;
  wrongChannel: number;
  unexpectedServices: number;
  /** Group-addressed telegrams whose APCI is not GroupValueRead/Response/Write and so were NOT
   * decoded. Includes any secured traffic, but this counter does not claim to identify it. */
  undecodedGroupTelegrams: number;
  /** Subscriber callbacks that threw; the session itself is never affected. */
  listenerErrors: number;
  malformedFrames: Record<string, number>;
  malformedCemi: Record<string, number>;
  confirmations: { confirmed: number; busError: number; notConfirmed: number };
  lastActivityAt: number | null;
  closedReason: CloseReason | null;
  closedDetail: string | null;
}

export interface ClosedEvent {
  reason: CloseReason;
  error?: KnxTunnelError;
}

interface PendingSend {
  input: SendInput;
  resolve(r: SendReceipt): void;
  reject(e: KnxTunnelError): void;
}

interface InFlight {
  send: PendingSend;
  sequence: number;
  frame: Buffer;
  attempts: number;
  firstSentAt: number;
  timer: TimerHandle | null;
}

interface PendingConfirmation {
  destination: number;
  service: GroupService;
  settle(o: ConfirmationOutcome): void;
  timer: TimerHandle | null;
}

type Listener<T> = (value: T) => void;

const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };

export class KnxTunnelClient {
  private _state: TunnelState = "idle";
  private readonly clock: Clock;
  private readonly port: number;
  private readonly cfg: Required<Pick<TunnelClientOptions,
    "connectTimeoutMs" | "ackTimeoutMs" | "maxSendAttempts" | "heartbeatIntervalMs" | "heartbeatTimeoutMs" |
    "heartbeatMaxFailures" | "disconnectTimeoutMs" | "confirmationTimeoutMs" | "maxQueuedSends" | "maxPendingConfirmations" | "layer">>;

  private readonly link: TunnelLink;
  private linkOpen = false;
  private readonly stream: boolean;
  private channelId: number | null = null;
  private assigned: number | null = null;
  private txSeq = 0;
  private rxSeq = 0;

  private connectWaiter: { resolve(): void; reject(e: KnxTunnelError): void; timer: TimerHandle | null; sentAt: number } | null = null;
  private disconnectTimer: TimerHandle | null = null;
  private readonly queue: PendingSend[] = [];
  private inFlight: InFlight | null = null;
  private readonly confirmations: PendingConfirmation[] = [];

  private hbTimer: TimerHandle | null = null;
  private hbRespTimer: TimerHandle | null = null;
  private hbSentAt = 0;
  private hbTry = 0;

  private readonly telegramListeners = new Set<Listener<CemiFrame>>();
  private readonly closedListeners = new Set<Listener<ClosedEvent>>();
  private readonly decodeErrorListeners = new Set<Listener<{ layer: "frame" | "cemi"; code: string; raw: Buffer }>>();
  private closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  private readonly stats: TunnelDiagnostics;

  constructor(private readonly opts: TunnelClientOptions) {
    if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(opts.host)) throw new KnxTunnelError("invalid_argument", `gateway host "${opts.host}" must be an IPv4 literal`);
    assertPolicySatisfiable(opts.security ?? PLAIN_POLICY);
    this.clock = opts.clock ?? systemClock;
    this.port = opts.port ?? 3671;
    if (!opts.link && !opts.socketFactory) throw new KnxTunnelError("invalid_argument", "either a socketFactory or a link is required");
    this.link = opts.link ?? new UdpTunnelLink(opts.host, this.port, opts.socketFactory!);
    this.stream = this.link.kind === "secure-stream";
    if (this.stream) {
      // Fail closed: unverified stream rules may run only over an in-memory transport (tunnel-rules.ts).
      const blockers = unverifiedBlockers(STREAM_RULES);
      if (blockers.length > 0 && this.link.simulated !== true) {
        throw new KnxTunnelError("invalid_argument", `stream tunnelling is refused on a real transport: unverified rules ${blockers.join(", ")} (docs/architecture/knx-secure-blocker-matrix.md)`);
      }
    }
    this.cfg = {
      connectTimeoutMs: opts.connectTimeoutMs ?? 10_000,
      ackTimeoutMs: opts.ackTimeoutMs ?? 1_000,
      maxSendAttempts: opts.maxSendAttempts ?? 2,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 60_000,
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 10_000,
      heartbeatMaxFailures: opts.heartbeatMaxFailures ?? 3,
      disconnectTimeoutMs: opts.disconnectTimeoutMs ?? 5_000,
      confirmationTimeoutMs: opts.confirmationTimeoutMs ?? 3_000,
      maxQueuedSends: opts.maxQueuedSends ?? 64,
      maxPendingConfirmations: opts.maxPendingConfirmations ?? 16,
      layer: opts.layer ?? TunnelLayer.LINK,
    };
    this.closedPromise = new Promise<void>((r) => { this.resolveClosed = r; });
    this.stats = {
      state: "idle", link: this.link.kind, ignoredAcks: 0, channelId: null, assignedAddress: null, gateway: `${opts.host}:${this.port}`, connectLatencyMs: null,
      heartbeat: { sent: 0, failures: 0, lastRttMs: null, lastOkAt: null },
      framesSent: 0, framesReceived: 0, telegramsDelivered: 0, acksReceived: 0, sendRetries: 0, staleAcks: 0,
      duplicateInbound: 0, outOfOrderInbound: 0, foreignDatagrams: 0, wrongChannel: 0, unexpectedServices: 0, undecodedGroupTelegrams: 0, listenerErrors: 0,
      malformedFrames: {}, malformedCemi: {}, confirmations: { confirmed: 0, busError: 0, notConfirmed: 0 },
      lastActivityAt: null, closedReason: null, closedDetail: null,
    };
  }

  get state(): TunnelState { return this._state; }
  /** Individual address the gateway assigned to this tunnel (raw 16-bit), once connected. */
  get assignedAddress(): number | null { return this.assigned; }

  diagnostics(): TunnelDiagnostics {
    return {
      ...this.stats, state: this._state, channelId: this.channelId, assignedAddress: this.assigned,
      heartbeat: { ...this.stats.heartbeat }, malformedFrames: { ...this.stats.malformedFrames },
      malformedCemi: { ...this.stats.malformedCemi }, confirmations: { ...this.stats.confirmations },
    };
  }

  /** Subscribes to inbound L_Data.ind telegrams (from other bus participants). */
  onTelegram(fn: Listener<CemiFrame>): () => void { this.telegramListeners.add(fn); return () => { this.telegramListeners.delete(fn); }; }
  onClosed(fn: Listener<ClosedEvent>): () => void { this.closedListeners.add(fn); return () => { this.closedListeners.delete(fn); }; }
  onDecodeError(fn: Listener<{ layer: "frame" | "cemi"; code: string; raw: Buffer }>): () => void { this.decodeErrorListeners.add(fn); return () => { this.decodeErrorListeners.delete(fn); }; }

  // -------------------------------------------------------------------------------------
  // connect

  async connect(): Promise<void> {
    if (this._state !== "idle") throw new KnxTunnelError("invalid_argument", `connect() called in state "${this._state}"; clients are single-use`);
    this._state = "connecting";
    try {
      await this.link.open({
        onFrame: (data) => this.onFrame(data),
        onForeign: () => { if (this._state !== "closed" && this._state !== "idle") this.stats.foreignDatagrams++; },
        onError: (err) => this.onSocketError(err),
        onClosed: (reason) => { if (this.linkOpen) this.shutdown("session_closed", new KnxTunnelError("session_closed", reason)); },
      });
      this.linkOpen = true;
    } catch (err) {
      const e = new KnxTunnelError("socket_error", `cannot open ${this.stream ? "secure stream" : "UDP socket"}: ${err instanceof Error ? err.message : String(err)}`);
      this.shutdown("socket_error", e);
      throw e;
    }
    // shutdown() may have run while the socket was opening (e.g. disconnect() during connect).
    if (this._state !== "connecting") {
      this.link.close();
      this.linkOpen = false;
      throw new KnxTunnelError("closed", "closed while connecting");
    }
    return new Promise<void>((resolve, reject) => {
      const sentAt = this.clock.now();
      this.connectWaiter = {
        resolve, reject, sentAt,
        timer: this.clock.setTimeout(() => {
          const e = new KnxTunnelError("connect_timeout", `no CONNECT_RESPONSE from ${this.stats.gateway} within ${this.cfg.connectTimeoutMs}ms`);
          this.shutdown("connect_timeout", e);
        }, this.cfg.connectTimeoutMs),
      };
      this.transmit(encodeConnectRequest({ controlEndpoint: NAT_HPAI, dataEndpoint: NAT_HPAI, layer: this.cfg.layer }));
    });
  }

  // -------------------------------------------------------------------------------------
  // send

  /** Queues one group telegram. Resolves when the gateway ACKs it (not when the bus
   * confirms — see {@link SendReceipt.confirmation}); rejects with a {@link KnxTunnelError}. */
  sendGroup(input: SendInput): Promise<SendReceipt> {
    if (this._state !== "connected") return Promise.reject(new KnxTunnelError("not_connected", `cannot send in state "${this._state}"`));
    if (this.queue.length >= this.cfg.maxQueuedSends) return Promise.reject(new KnxTunnelError("queue_full", `send queue holds ${this.cfg.maxQueuedSends} frames`));
    try {
      // Fail fast on invalid input, before it occupies a queue slot.
      encodeGroupCemi({ source: this.assigned ?? 0, destination: input.destination, service: input.service, data: input.data ?? null });
    } catch (err) {
      return Promise.reject(new KnxTunnelError("invalid_argument", err instanceof Error ? err.message : String(err)));
    }
    return new Promise<SendReceipt>((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.inFlight || this._state !== "connected") return;
    const next = this.queue.shift();
    if (!next) return;
    const cemi = encodeGroupCemi({
      messageCode: CemiMessageCode.L_DATA_REQ, source: this.assigned ?? 0, destination: next.input.destination,
      service: next.input.service, data: next.input.data ?? null, priority: next.input.priority,
    });
    if (this.stream) { this.sendStream(next, cemi); return; }
    const sequence = this.txSeq;
    const flight: InFlight = {
      send: next, sequence, attempts: 0, firstSentAt: this.clock.now(), timer: null,
      frame: encodeTunnellingRequest({ channelId: this.channelId!, sequence, cemi }),
    };
    this.inFlight = flight;
    this.transmitFlight(flight);
  }

  /** Stream mode (TUN §2.6.2): no ACK exists, so there is nothing to wait for, repeat or time out; the send is complete once the session accepted the frame. */
  private sendStream(next: PendingSend, cemi: Buffer): void {
    const sequence = STREAM_RULES.sendSequence.value;
    try {
      this.transmit(encodeTunnellingRequest({ channelId: this.channelId!, sequence, cemi }));
    } catch (e) {
      const err = new KnxTunnelError("session_closed", `secure session refused the frame: ${e instanceof Error ? e.message : String(e)}`);
      next.reject(err);
      this.shutdown("session_closed", err);
      return;
    }
    next.resolve({ transportAck: "none", sequence, ackedAt: null, ackLatencyMs: null, attempts: 1, confirmation: this.expectConfirmation(next.input) });
    this.pump();
  }

  private transmitFlight(f: InFlight): void {
    f.attempts++;
    if (f.attempts > 1) this.stats.sendRetries++;
    this.transmit(f.frame);
    f.timer = this.clock.setTimeout(() => {
      if (this.inFlight !== f) return;
      if (f.attempts < this.cfg.maxSendAttempts) { this.transmitFlight(f); return; }
      // TUN §2.6.1: after the repeat, "terminate the connection by sending a DISCONNECT_REQUEST".
      this.terminate("ack_timeout", new KnxTunnelError("ack_timeout", `no TUNNELLING_ACK for sequence ${f.sequence} after ${f.attempts} attempt(s); tunnel terminated`));
    }, this.cfg.ackTimeoutMs);
  }

  // -------------------------------------------------------------------------------------
  // receive

  private onFrame(data: Buffer): void {
    if (this._state === "closed" || this._state === "idle") return;
    let frame;
    try { frame = decodeFrame(data); } catch (e) {
      if (e instanceof KnxFrameError) { bump(this.stats.malformedFrames, e.code); this.emitDecodeError("frame", e.code, data); }
      return;
    }
    this.stats.framesReceived++;
    this.stats.lastActivityAt = this.clock.now();
    try {
      this.dispatch(frame.service, frame.body);
    } catch (e) {
      if (e instanceof KnxFrameError) { bump(this.stats.malformedFrames, e.code); this.emitDecodeError("frame", e.code, data); return; }
      throw e;
    }
  }

  private dispatch(service: number, body: Buffer): void {
    if (this._state === "connecting") {
      if (service === ServiceType.CONNECT_RESPONSE) this.onConnectResponse(body);
      else this.stats.unexpectedServices++;
      return;
    }
    switch (service) {
      case ServiceType.TUNNELLING_ACK: return this.onAck(body);
      case ServiceType.TUNNELLING_REQUEST: return this.onTunnellingRequest(body);
      case ServiceType.CONNECTIONSTATE_RESPONSE: return this.onHeartbeatResponse(body);
      case ServiceType.DISCONNECT_REQUEST: return this.onGatewayDisconnect(body);
      case ServiceType.DISCONNECT_RESPONSE: return this.onDisconnectResponse(body);
      default: this.stats.unexpectedServices++;
    }
  }

  private onConnectResponse(body: Buffer): void {
    const r = decodeConnectResponse(body);
    const w = this.connectWaiter;
    if (!w) { this.stats.unexpectedServices++; return; }
    if (r.status !== StatusCode.NO_ERROR) {
      this.shutdown("connect_rejected", new KnxTunnelError("connect_rejected", `gateway refused the tunnel: ${describeStatus(r.status)}`, r.status));
      return;
    }
    if (w.timer) this.clock.clearTimeout(w.timer);
    this.connectWaiter = null;
    this.channelId = r.channelId;
    this.assigned = r.assignedAddress ?? null;
    this.link.routeBack(r.dataEndpoint);
    this._state = "connected";
    this.stats.connectLatencyMs = this.clock.now() - w.sentAt;
    this.scheduleHeartbeat();
    w.resolve();
  }

  private onAck(body: Buffer): void {
    if (this.stream) { this.stats.ignoredAcks++; return; }                 // TUN §2.6.2: "Received TUNNELLING_ACK Frames shall be ignored."
    const a = decodeTunnellingAck(body);
    if (a.channelId !== this.channelId) { this.stats.wrongChannel++; return; }
    const f = this.inFlight;
    if (!f || a.sequence !== f.sequence) { this.stats.staleAcks++; return; }
    if (f.timer) this.clock.clearTimeout(f.timer);
    this.stats.acksReceived++;
    if (a.status !== StatusCode.NO_ERROR) {
      // TUN §2.6.1: an ACK "signal[ling] any kind of error condition" is handled exactly like a missing
      // ACK — repeat the request once with the same sequence, then terminate the connection.
      if (f.attempts < this.cfg.maxSendAttempts) { this.transmitFlight(f); return; }
      const err = new KnxTunnelError("ack_error", `gateway rejected frame ${f.sequence}: ${describeStatus(a.status)}`, a.status);
      this.terminate("ack_error", err);
      return;
    }
    this.inFlight = null;
    this.txSeq = (this.txSeq + 1) & 0xff;
    const now = this.clock.now();
    f.send.resolve({
      transportAck: "ack", sequence: f.sequence, ackedAt: now, ackLatencyMs: now - f.firstSentAt, attempts: f.attempts,
      confirmation: this.expectConfirmation(f.send.input),
    });
    this.pump();
  }

  private expectConfirmation(input: SendInput): Promise<ConfirmationOutcome> {
    return new Promise<ConfirmationOutcome>((resolve) => {
      const entry: PendingConfirmation = {
        destination: input.destination, service: input.service, timer: null,
        settle: (o) => {
          if (entry.timer) this.clock.clearTimeout(entry.timer);
          const i = this.confirmations.indexOf(entry);
          if (i >= 0) this.confirmations.splice(i, 1);
          if (o === "confirmed") this.stats.confirmations.confirmed++;
          else if (o === "bus_error") this.stats.confirmations.busError++;
          else this.stats.confirmations.notConfirmed++;
          resolve(o);
        },
      };
      this.confirmations.push(entry);
      if (this.confirmations.length > this.cfg.maxPendingConfirmations) this.confirmations[0]!.settle("not_confirmed");
      entry.timer = this.clock.setTimeout(() => entry.settle("not_confirmed"), this.cfg.confirmationTimeoutMs);
    });
  }

  private onTunnellingRequest(body: Buffer): void {
    const req = decodeTunnellingRequest(body);
    if (req.channelId !== this.channelId) { this.stats.wrongChannel++; return; }
    if (this.stream) return this.deliverInbound(req.cemi);                  // TUN §2.6.2: sequence not evaluated, no TUNNELLING_ACK sent
    const ack = (): void => this.transmit(encodeTunnellingAck({ channelId: req.channelId, sequence: req.sequence, status: StatusCode.NO_ERROR }));
    if (req.sequence === this.rxSeq) {
      this.rxSeq = (this.rxSeq + 1) & 0xff;
      ack(); // transport-level ACK precedes (and is independent of) cEMI interpretation
    } else if (req.sequence === ((this.rxSeq - 1) & 0xff)) {
      this.stats.duplicateInbound++;
      ack(); // our earlier ACK was lost; re-ACK but never deliver twice
      return;
    } else {
      this.stats.outOfOrderInbound++;
      return;
    }
    this.deliverInbound(req.cemi);
  }

  private deliverInbound(raw: Buffer): void {
    let cemi: CemiFrame;
    try { cemi = decodeCemi(raw); } catch (e) {
      if (e instanceof KnxCemiError) { bump(this.stats.malformedCemi, e.code); this.emitDecodeError("cemi", e.code, raw); return; }
      throw e;
    }
    if (cemi.messageCode === CemiMessageCode.L_DATA_CON) { this.onConfirmation(cemi); return; }
    if (cemi.messageCode !== CemiMessageCode.L_DATA_IND) { this.stats.unexpectedServices++; return; }
    if (cemi.destinationIsGroup && cemi.group === null) { this.stats.undecodedGroupTelegrams++; return; }
    this.stats.telegramsDelivered++;
    this.notify(this.telegramListeners, cemi);
  }

  private onConfirmation(c: CemiFrame): void {
    if (!c.destinationIsGroup || !c.group) return;
    const entry = this.confirmations.find((p) => p.destination === c.destination && p.service === c.group!.service);
    entry?.settle(c.confirmError ? "bus_error" : "confirmed");
  }

  // -------------------------------------------------------------------------------------
  // heartbeat

  private scheduleHeartbeat(): void {
    if (this.stream) return;                                                // B4 unverified: no KNX-level heartbeat in stream mode (session KEEPALIVE only)
    this.hbTry = 0;
    this.hbTimer = this.clock.setTimeout(() => this.sendHeartbeat(), this.cfg.heartbeatIntervalMs);
  }

  private sendHeartbeat(): void {
    if (this._state !== "connected") return;
    this.hbSentAt = this.clock.now();
    this.hbTry++;
    this.stats.heartbeat.sent++;
    this.transmit(encodeConnectionStateRequest({ channelId: this.channelId!, endpoint: NAT_HPAI }));
    this.hbRespTimer = this.clock.setTimeout(() => {
      this.stats.heartbeat.failures++;
      if (this.hbTry >= this.cfg.heartbeatMaxFailures) {
        this.shutdown("heartbeat_lost", new KnxTunnelError("heartbeat_lost", `no CONNECTIONSTATE_RESPONSE after ${this.hbTry} attempts`));
      } else {
        this.sendHeartbeat();
      }
    }, this.cfg.heartbeatTimeoutMs);
  }

  private onHeartbeatResponse(body: Buffer): void {
    const r = decodeConnectionStateResponse(body);
    if (r.channelId !== this.channelId) { this.stats.wrongChannel++; return; }
    if (!this.hbRespTimer) { this.stats.unexpectedServices++; return; }
    this.clock.clearTimeout(this.hbRespTimer);
    this.hbRespTimer = null;
    if (r.status !== StatusCode.NO_ERROR) {
      this.shutdown("heartbeat_lost", new KnxTunnelError("heartbeat_lost", `gateway reports the connection as unhealthy: ${describeStatus(r.status)}`, r.status));
      return;
    }
    const now = this.clock.now();
    this.stats.heartbeat.lastRttMs = now - this.hbSentAt;
    this.stats.heartbeat.lastOkAt = now;
    this.scheduleHeartbeat();
  }

  // -------------------------------------------------------------------------------------
  // disconnect / teardown

  private onGatewayDisconnect(body: Buffer): void {
    const r = decodeDisconnectRequest(body);
    if (r.channelId !== this.channelId) { this.stats.wrongChannel++; return; }
    if (!this.stream) this.transmit(encodeDisconnectResponse({ channelId: r.channelId, status: StatusCode.NO_ERROR }));   // B5: stream response unverified
    this.shutdown("gateway_disconnect", new KnxTunnelError("gateway_disconnect", "gateway terminated the tunnel"));
  }

  private onDisconnectResponse(body: Buffer): void {
    const r = decodeDisconnectResponse(body);
    if (r.channelId !== this.channelId || this._state !== "disconnecting") { this.stats.unexpectedServices++; return; }
    this.shutdown("local_disconnect");
  }

  /** Orderly shutdown. Always ends `closed`, never throws, safe to call in any state. */
  async disconnect(): Promise<void> {
    if (this._state === "closed") return;
    if (this._state === "idle") { this.shutdown("local_disconnect"); return; }
    if (this._state === "disconnecting") { await this.closedPromise; return; }
    if (this._state === "connecting") { this.shutdown("local_disconnect"); return; }
    if (this.stream) { this.shutdown("local_disconnect"); return; }         // B5 unverified: closing the secure session closes the connection implicitly (IPS §2.4.2)
    this._state = "disconnecting";
    this.clearHeartbeat();
    this.failPending(new KnxTunnelError("closed", "tunnel is disconnecting"));
    this.transmit(encodeDisconnectRequest({ channelId: this.channelId!, endpoint: NAT_HPAI }));
    this.disconnectTimer = this.clock.setTimeout(() => this.shutdown("local_disconnect"), this.cfg.disconnectTimeoutMs);
    await this.closedPromise;
  }

  /** Resolves when the session has fully closed (any reason). */
  whenClosed(): Promise<void> { return this.closedPromise; }

  /** Spec-mandated teardown of a session whose frames cannot be delivered: tell the server, then close. */
  private terminate(reason: CloseReason, error: KnxTunnelError): void {
    if (this._state === "connected" && this.channelId !== null) {
      this.transmit(encodeDisconnectRequest({ channelId: this.channelId, endpoint: NAT_HPAI }));
    }
    this.shutdown(reason, error);
  }

  private shutdown(reason: CloseReason, error?: KnxTunnelError): void {
    if (this._state === "closed") return;
    this._state = "closed";
    this.stats.closedReason = reason;
    this.stats.closedDetail = error?.message ?? null;
    this.clearHeartbeat();
    if (this.connectWaiter) {
      if (this.connectWaiter.timer) this.clock.clearTimeout(this.connectWaiter.timer);
      this.connectWaiter.reject(error ?? new KnxTunnelError("closed", "closed while connecting"));
      this.connectWaiter = null;
    }
    if (this.disconnectTimer) this.clock.clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
    this.failPending(error ?? new KnxTunnelError("closed", "tunnel closed"));
    for (const c of [...this.confirmations]) c.settle("not_confirmed");
    this.link.close();
    this.linkOpen = false;
    this.resolveClosed();
    const ev: ClosedEvent = error ? { reason, error } : { reason };
    this.notify(this.closedListeners, ev);
    this.telegramListeners.clear();
    this.closedListeners.clear();
    this.decodeErrorListeners.clear();
  }

  private failPending(err: KnxTunnelError): void {
    if (this.inFlight) {
      if (this.inFlight.timer) this.clock.clearTimeout(this.inFlight.timer);
      this.inFlight.send.reject(err);
      this.inFlight = null;
    }
    for (const q of this.queue.splice(0)) q.reject(err);
  }

  private clearHeartbeat(): void {
    if (this.hbTimer) this.clock.clearTimeout(this.hbTimer);
    if (this.hbRespTimer) this.clock.clearTimeout(this.hbRespTimer);
    this.hbTimer = null;
    this.hbRespTimer = null;
  }

  private onSocketError(err: Error): void {
    if (this._state === "closed") return;
    this.shutdown("socket_error", new KnxTunnelError("socket_error", `UDP socket error: ${err.message}`));
  }

  private transmit(frame: Buffer): void {
    if (!this.linkOpen) return;
    this.stats.framesSent++;
    this.link.send(frame);
  }

  /** Calls every subscriber; one throwing never affects the others or the session. */
  private notify<T>(set: Set<Listener<T>>, value: T): void {
    for (const l of [...set]) {
      try { l(value); } catch { this.stats.listenerErrors++; }
    }
  }

  private emitDecodeError(layer: "frame" | "cemi", code: string, raw: Buffer): void {
    this.notify(this.decodeErrorListeners, { layer, code, raw });
  }
}
