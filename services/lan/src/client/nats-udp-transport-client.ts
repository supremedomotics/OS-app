import type { IEventBus, Subscription } from "@supreme/messaging";
import { requestReply } from "../shared/rpc.js";
import {
  lanSubjects,
  type LanBindRequest,
  type LanBindResponse,
  type LanCloseRequest,
  type LanCloseResponse,
  type LanJoinMulticastRequest,
  type LanJoinMulticastResponse,
  type LanRxEvent,
  type LanErrorEvent,
  type LanListeningEvent,
  type LanSendRequest,
  type LanSendResponse,
  type LanSessionId,
  type LanUdpBindOptions,
} from "../shared/wire-types.js";
import type { UdpBindOptions, UdpTransport } from "../transport.js";

/**
 * The Gateway-side half of the transport: implements {@link UdpTransport} by talking to a running
 * `supreme-lan` server over the shared `IEventBus` (§ Production Architecture Refactor). This is
 * the ONLY thing a protocol driver needs — it never knows or cares whether the bus underneath is
 * `InProcessEventBus` (tests, or a single-process dev stack with `supreme-lan` not deployed) or a
 * real `NatsEventBus` reaching a `supreme-lan` container over the network.
 */
export class NatsUdpTransportClient implements UdpTransport {
  private sessionId: LanSessionId | null = null;
  private localAddr: { address: string; port: number } | null = null;
  private readonly messageListeners = new Set<(msg: Buffer, rinfo: { address: string; port: number }) => void>();
  private readonly errorListeners = new Set<(err: Error) => void>();
  private readonly listeningListeners = new Set<() => void>();
  private subs: Subscription[] = [];
  /** § LAN Transport Phase 2 — Transport Monitor's "NATS" section: real counts of the bus
   * operations THIS client instance performed, not an estimate. `requestsSent` is every
   * request/reply command (bind/send/close/joinMulticast); `eventsReceived` is every session-
   * scoped event (rx/error/listening) actually delivered back over the bus. There is no "dropped"
   * counter — neither `IEventBus` implementation has a queue that can silently drop a message
   * today, so reporting one would be a fabricated metric, not a measured one. */
  private _requestsSent = 0;
  private _eventsReceived = 0;
  private _packetsSent = 0;
  private _packetsReceived = 0;
  private _lastError: string | null = null;
  private _lastSendDiagnosis: unknown = null;

  constructor(
    private readonly bus: IEventBus,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  async bind(opts: UdpBindOptions = {}): Promise<void> {
    if (this.sessionId) throw new Error("supreme-lan: transport already bound — call close() first");
    this._requestsSent += 1;
    const res = await requestReply<LanBindRequest, LanBindResponse>(
      this.bus,
      lanSubjects.bind,
      { opts: opts satisfies LanUdpBindOptions },
      this.opts,
    );
    if (!res.ok) throw new Error(`supreme-lan: bind failed — ${res.error}`);
    this.sessionId = res.sessionId;
    this.localAddr = { address: res.localAddress, port: res.localPort };

    this.subs.push(
      await this.bus.subscribe<LanRxEvent>(lanSubjects.sessionRx(res.sessionId), (evt) => {
        this._eventsReceived += 1;
        this._packetsReceived += 1;
        const buf = Buffer.from(evt.dataBase64, "base64");
        for (const l of this.messageListeners) l(buf, evt.rinfo);
      }),
    );
    this.subs.push(
      await this.bus.subscribe<LanErrorEvent>(lanSubjects.sessionError(res.sessionId), (evt) => {
        this._eventsReceived += 1;
        this._lastError = evt.message;
        for (const l of this.errorListeners) l(new Error(evt.message));
      }),
    );
    this.subs.push(
      await this.bus.subscribe<LanListeningEvent>(lanSubjects.sessionListening(res.sessionId), () => {
        this._eventsReceived += 1;
        for (const l of this.listeningListeners) l();
      }),
    );
    for (const l of this.listeningListeners) l();
  }

  async send(data: Buffer, port: number, address: string): Promise<void> {
    if (!this.sessionId) throw new Error("supreme-lan: send() called before bind()");
    this._requestsSent += 1;
    const res = await requestReply<LanSendRequest, LanSendResponse>(
      this.bus,
      lanSubjects.send,
      { sessionId: this.sessionId, host: address, port, dataBase64: data.toString("base64") },
      this.opts,
    );
    if (!res.ok) {
      this._lastError = res.error;
      // § ENETUNREACH investigation — the server attaches a real routing diagnosis computed inside
      // its OWN network namespace (the only place that can answer "is there even a route?").
      // Keep it verbatim; never synthesize one Gateway-side, where the interfaces belong to a
      // different container entirely.
      this._lastSendDiagnosis = res.diagnosis ?? null;
      throw new Error(`supreme-lan: send failed — ${res.error}`);
    }
    this._packetsSent += 1;
    this._lastSendDiagnosis = null;
  }

  async joinMulticast(group: string, iface?: string): Promise<void> {
    if (!this.sessionId) throw new Error("supreme-lan: joinMulticast() called before bind()");
    this._requestsSent += 1;
    const res = await requestReply<LanJoinMulticastRequest, LanJoinMulticastResponse>(
      this.bus,
      lanSubjects.joinMulticast,
      { sessionId: this.sessionId, group, iface },
      this.opts,
    );
    if (!res.ok) throw new Error(`supreme-lan: joinMulticast failed — ${res.error}`);
  }

  async close(): Promise<void> {
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.localAddr = null;
    for (const sub of this.subs) sub.unsubscribe();
    this.subs = [];
    if (!sessionId) return;
    this._requestsSent += 1;
    await requestReply<LanCloseRequest, LanCloseResponse>(this.bus, lanSubjects.close, { sessionId }, this.opts);
  }

  onMessage(cb: (msg: Buffer, rinfo: { address: string; port: number }) => void): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }
  onError(cb: (err: Error) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }
  onListening(cb: () => void): () => void {
    this.listeningListeners.add(cb);
    return () => this.listeningListeners.delete(cb);
  }
  address(): { address: string; port: number } | null {
    return this.localAddr;
  }

  /** § LAN Transport Phase 2 — Transport Monitor's "NATS" section. Real counts scoped to this
   * one client instance/session, not the whole `supreme-lan` service (see `queryLanHealth` for
   * the service-wide view). */
  get packetsSent(): number {
    return this._packetsSent;
  }
  get packetsReceived(): number {
    return this._packetsReceived;
  }
  get lastError(): string | null {
    return this._lastError;
  }
  /** § ENETUNREACH investigation — the `RoutingDiagnosis` the supreme-lan server attached to the
   * most recent failed send (interfaces, outbound interface, platform, deployment mode, verdict,
   * explanation, suggested fix), or `null` if the last send succeeded / no diagnosis was
   * supplied. Read by the Casambi Transport Monitor so an installer sees "deployment" rather than
   * a bare errno. */
  get lastSendDiagnosis(): unknown {
    return this._lastSendDiagnosis;
  }
  get requestsSent(): number {
    return this._requestsSent;
  }
  get eventsReceived(): number {
    return this._eventsReceived;
  }
}
