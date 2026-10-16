/**
 * SIMULATION INFRASTRUCTURE — a virtual KNXnet/IP tunnelling interface (gateway) in front
 * of a {@link VirtualKnxBus}. Implements the SERVER side of the tunnelling procedures using
 * the same frame/cEMI codecs as the real client, so frames cross a genuine encode→wire→
 * decode boundary in both directions.
 *
 * Fault controls (all deterministic) model the failure modes the driver must survive:
 * gateway offline/reboot, tunnel silently forgotten, refused connections, dropped ACKs,
 * missing/errored bus confirmation, gateway-initiated disconnect.
 *
 * This is a model, not a certified interface: passing tests here is NOT hardware validation.
 */
import { CemiMessageCode, decodeCemi, encodeGroupCemi } from "../cemi.js";
import {
  decodeConnectRequest, decodeConnectionStateRequest, decodeDisconnectRequest, decodeDisconnectResponse, decodeFrame,
  decodeTunnellingAck, decodeTunnellingRequest, encodeConnectResponse, encodeConnectionStateResponse,
  encodeDisconnectRequest, encodeDisconnectResponse, encodeTunnellingAck, encodeTunnellingRequest, KnxFrameError,
  ServiceType, StatusCode, TunnelLayer,
} from "../knxnetip-frame.js";
import type { Clock, RemoteInfo, TimerHandle } from "../transport.js";
import type { BusTelegram, VirtualKnxBus } from "./virtual-bus.js";
import type { VirtualNetwork } from "./virtual-network.js";

export interface VirtualInterfaceOptions {
  address: string;
  port?: number;
  maxTunnels?: number;
  /** Individual addresses handed to tunnels, in order. */
  tunnelAddresses?: number[];
  /** Real interfaces drop a tunnel that stays silent this long (spec: 120 s). */
  idleTimeoutMs?: number;
}

interface Channel {
  id: number;
  client: RemoteInfo;
  ia: number;
  rxSeq: number;
  txSeq: number;
  out: Buffer[]; // cEMI frames waiting to be sent to the client
  inflight: { seq: number; frame: Buffer; attempts: number; timer: TimerHandle } | null;
  idle: TimerHandle;
}

export interface InterfaceFaults {
  online: boolean;
  /** Refuse CONNECT_REQUEST with this status (e.g. 0x24 no more connections). */
  refuseConnectStatus: number | null;
  /** Never ACK TUNNELLING_REQUESTs from clients. */
  dropAcks: boolean;
  /** Do not send L_Data.con for client frames. */
  suppressConfirmation: boolean;
  /** Send L_Data.con with the error flag (frame not acknowledged on the bus). */
  confirmationError: boolean;
}

export interface InterfaceCounters {
  connects: number; refusedConnects: number; disconnects: number; heartbeats: number;
  tunnellingRequests: number; duplicateRequests: number; outOfOrderRequests: number;
  malformed: number; indicationsSent: number; idleDrops: number;
}

export class VirtualKnxInterface {
  readonly faults: InterfaceFaults = { online: true, refuseConnectStatus: null, dropAcks: false, suppressConfirmation: false, confirmationError: false };
  readonly counters: InterfaceCounters = { connects: 0, refusedConnects: 0, disconnects: 0, heartbeats: 0, tunnellingRequests: 0, duplicateRequests: 0, outOfOrderRequests: 0, malformed: 0, indicationsSent: 0, idleDrops: 0 };
  private readonly channels = new Map<number, Channel>();
  private readonly self: RemoteInfo;
  private readonly cfg: Required<Omit<VirtualInterfaceOptions, "address" | "port">>;
  private detach: (() => void) | null;
  private unmonitor: (() => void) | null;

  constructor(private readonly net: VirtualNetwork, private readonly bus: VirtualKnxBus, private readonly clock: Clock, opts: VirtualInterfaceOptions) {
    this.self = { address: opts.address, port: opts.port ?? 3671 };
    this.cfg = {
      maxTunnels: opts.maxTunnels ?? 4,
      tunnelAddresses: opts.tunnelAddresses ?? [0xff01, 0xff02, 0xff03, 0xff04],
      idleTimeoutMs: opts.idleTimeoutMs ?? 120_000,
    };
    this.detach = net.listen(this.self.address, this.self.port, (d, from) => this.onDatagram(d, from));
    this.unmonitor = bus.monitor((t) => this.relay(t));
  }

  get activeChannels(): number { return this.channels.size; }
  channelAddresses(): number[] { return [...this.channels.values()].map((c) => c.ia); }

  // ---- fault controls -------------------------------------------------------------------

  /** Silently forgets a tunnel (gateway-side loss with no notice to the client). */
  dropChannel(id: number): void { this.removeChannel(id); }

  /** Gateway power-cycle: every tunnel forgotten, interface unreachable for `downMs`. */
  reboot(downMs: number): void {
    for (const id of [...this.channels.keys()]) this.removeChannel(id);
    this.faults.online = false;
    this.clock.setTimeout(() => { this.faults.online = true; }, downMs);
  }

  /** Gateway-initiated termination. */
  kickChannel(id: number): void {
    const ch = this.channels.get(id);
    if (!ch) return;
    this.send(ch.client, encodeDisconnectRequest({ channelId: id, endpoint: { protocol: 1, address: this.self.address, port: this.self.port } }));
    // Real servers wait for a response; the model removes the channel after the same timeout.
    this.clock.setTimeout(() => this.removeChannel(id), 5000);
  }

  shutdown(): void {
    for (const id of [...this.channels.keys()]) this.removeChannel(id);
    this.detach?.(); this.detach = null;
    this.unmonitor?.(); this.unmonitor = null;
  }

  // ---- server side ----------------------------------------------------------------------

  private onDatagram(data: Buffer, from: RemoteInfo): void {
    if (!this.faults.online) return;
    let frame;
    try { frame = decodeFrame(data); } catch (e) {
      if (e instanceof KnxFrameError) { this.counters.malformed++; return; }
      throw e;
    }
    try {
      switch (frame.service) {
        case ServiceType.CONNECT_REQUEST: return this.onConnect(frame.body, from);
        case ServiceType.CONNECTIONSTATE_REQUEST: return this.onHeartbeat(frame.body, from);
        case ServiceType.DISCONNECT_REQUEST: return this.onDisconnect(frame.body, from);
        case ServiceType.DISCONNECT_RESPONSE: { const r = decodeDisconnectResponse(frame.body); this.removeChannel(r.channelId); return; }
        case ServiceType.TUNNELLING_REQUEST: return this.onTunnelRequest(frame.body, from);
        case ServiceType.TUNNELLING_ACK: return this.onClientAck(frame.body);
        default: return;
      }
    } catch (e) {
      if (e instanceof KnxFrameError) { this.counters.malformed++; return; }
      throw e;
    }
  }

  private onConnect(body: Buffer, from: RemoteInfo): void {
    const req = decodeConnectRequest(body);
    const data = { protocol: 1, address: this.self.address, port: this.self.port };
    const refuse = (status: number): void => { this.counters.refusedConnects++; this.send(from, encodeConnectResponse({ channelId: 0, status })); };
    if (this.faults.refuseConnectStatus !== null) return refuse(this.faults.refuseConnectStatus);
    if (req.layer !== TunnelLayer.LINK) return refuse(StatusCode.TUNNELLING_LAYER);
    if (this.channels.size >= this.cfg.maxTunnels) return refuse(StatusCode.NO_MORE_CONNECTIONS);
    const used = new Set([...this.channels.values()].map((c) => c.ia));
    const ia = this.cfg.tunnelAddresses.find((a) => !used.has(a));
    if (ia === undefined) return refuse(StatusCode.NO_MORE_UNIQUE_CONNECTIONS);
    let id = 1;
    while (this.channels.has(id)) id++;
    const client = req.dataEndpoint.port === 0 ? from : { address: req.dataEndpoint.address, port: req.dataEndpoint.port };
    const ch: Channel = { id, client, ia, rxSeq: 0, txSeq: 0, out: [], inflight: null, idle: this.armIdle(id) };
    this.channels.set(id, ch);
    this.counters.connects++;
    this.send(from, encodeConnectResponse({ channelId: id, status: StatusCode.NO_ERROR, dataEndpoint: data, assignedAddress: ia }));
  }

  private onHeartbeat(body: Buffer, from: RemoteInfo): void {
    const req = decodeConnectionStateRequest(body);
    this.counters.heartbeats++;
    const ch = this.channels.get(req.channelId);
    if (!ch) { this.send(from, encodeConnectionStateResponse({ channelId: req.channelId, status: StatusCode.CONNECTION_ID })); return; }
    this.touch(ch);
    this.send(from, encodeConnectionStateResponse({ channelId: ch.id, status: StatusCode.NO_ERROR }));
  }

  private onDisconnect(body: Buffer, from: RemoteInfo): void {
    const req = decodeDisconnectRequest(body);
    const known = this.channels.has(req.channelId);
    this.send(from, encodeDisconnectResponse({ channelId: req.channelId, status: known ? StatusCode.NO_ERROR : StatusCode.CONNECTION_ID }));
    if (known) { this.counters.disconnects++; this.removeChannel(req.channelId); }
  }

  private onTunnelRequest(body: Buffer, from: RemoteInfo): void {
    const req = decodeTunnellingRequest(body);
    const ch = this.channels.get(req.channelId);
    if (!ch) return;
    this.touch(ch);
    this.counters.tunnellingRequests++;
    const ack = (): void => { if (!this.faults.dropAcks) this.send(from, encodeTunnellingAck({ channelId: ch.id, sequence: req.sequence, status: StatusCode.NO_ERROR })); };
    if (req.sequence === ch.rxSeq) {
      ch.rxSeq = (ch.rxSeq + 1) & 0xff;
      ack();
    } else if (req.sequence === ((ch.rxSeq - 1) & 0xff)) {
      this.counters.duplicateRequests++;
      ack();
      return;
    } else {
      this.counters.outOfOrderRequests++;
      return;
    }
    const cemi = decodeCemi(req.cemi);
    if (cemi.messageCode !== CemiMessageCode.L_DATA_REQ || !cemi.group || !cemi.destinationIsGroup) return;
    const telegram: BusTelegram = { source: ch.ia, destination: cemi.destination, service: cemi.group.service, data: cemi.group.data };
    const ok = this.bus.transmit(telegram);
    if (!this.faults.suppressConfirmation) {
      this.enqueue(ch, encodeGroupCemi({
        messageCode: CemiMessageCode.L_DATA_CON, source: ch.ia, destination: cemi.destination, service: telegram.service,
        data: telegram.data, confirmError: !ok || this.faults.confirmationError,
      }));
    }
  }

  private onClientAck(body: Buffer): void {
    const ack = decodeTunnellingAck(body);
    const ch = this.channels.get(ack.channelId);
    if (!ch || !ch.inflight || ch.inflight.seq !== ack.sequence) return;
    this.clock.clearTimeout(ch.inflight.timer);
    ch.inflight = null;
    ch.txSeq = (ch.txSeq + 1) & 0xff;
    this.touch(ch);
    this.pump(ch);
  }

  // ---- bus → clients --------------------------------------------------------------------

  private relay(t: BusTelegram): void {
    for (const ch of this.channels.values()) {
      if (t.source === ch.ia) continue; // a tunnel does not receive its own frames as indications
      this.counters.indicationsSent++;
      this.enqueue(ch, encodeGroupCemi({ messageCode: CemiMessageCode.L_DATA_IND, source: t.source, destination: t.destination, service: t.service, data: t.data }));
    }
  }

  private enqueue(ch: Channel, cemi: Buffer): void {
    if (!this.faults.online) return;
    ch.out.push(cemi);
    this.pump(ch);
  }

  private pump(ch: Channel): void {
    if (ch.inflight || !this.channels.has(ch.id)) return;
    const cemi = ch.out.shift();
    if (!cemi) return;
    const frame = encodeTunnellingRequest({ channelId: ch.id, sequence: ch.txSeq, cemi });
    const flight = { seq: ch.txSeq, frame, attempts: 1, timer: null as unknown as TimerHandle };
    ch.inflight = flight;
    this.send(ch.client, frame);
    const arm = (): void => {
      flight.timer = this.clock.setTimeout(() => {
        if (ch.inflight !== flight) return;
        if (flight.attempts < 2) { flight.attempts++; this.send(ch.client, frame); arm(); return; }
        this.removeChannel(ch.id); // client unresponsive: server terminates the tunnel
      }, 1000);
    };
    arm();
  }

  private armIdle(id: number): TimerHandle {
    return this.clock.setTimeout(() => { this.counters.idleDrops++; this.removeChannel(id); }, this.cfg.idleTimeoutMs);
  }

  private touch(ch: Channel): void {
    this.clock.clearTimeout(ch.idle);
    ch.idle = this.armIdle(ch.id);
  }

  private removeChannel(id: number): void {
    const ch = this.channels.get(id);
    if (!ch) return;
    this.clock.clearTimeout(ch.idle);
    if (ch.inflight) this.clock.clearTimeout(ch.inflight.timer);
    this.channels.delete(id);
  }

  private send(to: RemoteInfo, frame: Buffer): void {
    if (!this.faults.online) return;
    this.net.sendFrom(this.self, to, frame);
  }
}

