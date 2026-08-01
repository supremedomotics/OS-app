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

  constructor(
    private readonly bus: IEventBus,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  async bind(opts: UdpBindOptions = {}): Promise<void> {
    if (this.sessionId) throw new Error("supreme-lan: transport already bound — call close() first");
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
        const buf = Buffer.from(evt.dataBase64, "base64");
        for (const l of this.messageListeners) l(buf, evt.rinfo);
      }),
    );
    this.subs.push(
      await this.bus.subscribe<LanErrorEvent>(lanSubjects.sessionError(res.sessionId), (evt) => {
        for (const l of this.errorListeners) l(new Error(evt.message));
      }),
    );
    this.subs.push(
      await this.bus.subscribe<LanListeningEvent>(lanSubjects.sessionListening(res.sessionId), () => {
        for (const l of this.listeningListeners) l();
      }),
    );
    for (const l of this.listeningListeners) l();
  }

  async send(data: Buffer, port: number, address: string): Promise<void> {
    if (!this.sessionId) throw new Error("supreme-lan: send() called before bind()");
    const res = await requestReply<LanSendRequest, LanSendResponse>(
      this.bus,
      lanSubjects.send,
      { sessionId: this.sessionId, host: address, port, dataBase64: data.toString("base64") },
      this.opts,
    );
    if (!res.ok) throw new Error(`supreme-lan: send failed — ${res.error}`);
  }

  async joinMulticast(group: string, iface?: string): Promise<void> {
    if (!this.sessionId) throw new Error("supreme-lan: joinMulticast() called before bind()");
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
}
