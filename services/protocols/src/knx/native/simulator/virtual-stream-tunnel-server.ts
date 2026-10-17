/**
 * SIMULATION INFRASTRUCTURE — a tunnelling server that lives INSIDE a simulated KNX IP Secure session (stream mode). It follows only the rules
 * verified in tunnel-rules.ts (TUN §2.6.2: no TUNNELLING_ACK sent, received ACKs ignored, receive sequence not evaluated) and records everything it
 * receives so tests can assert what the client did NOT send. It is self-authored: it can show internal consistency, never interoperability.
 * Plug `onInner` into VirtualSecureGateway and call `bind(gateway)`.
 */
import { CemiMessageCode, decodeCemi, encodeGroupCemi, type GroupData, type GroupService } from "../cemi.js";
import {
  decodeConnectRequest, decodeFrame, decodeTunnellingRequest, encodeConnectResponse, encodeFrame, encodeTunnellingAck, encodeTunnellingRequest,
  HostProtocol, NAT_HPAI, ServiceType, StatusCode,
} from "../knxnetip-frame.js";
import type { ServerSession, VirtualSecureGateway } from "./virtual-secure-gateway.js";

export interface StreamTunnelServerOptions {
  assignedAddress?: number;
  channelId?: number;
  /** Answer every received L_Data.req with an L_Data.con (default true). */
  confirm?: boolean;
  /** Sequence value placed in server→client TUNNELLING_REQUESTs: always 0 (default), a running counter, or a fixed odd value. */
  sequenceMode?: "zero" | "counter" | number;
}

export class VirtualStreamTunnelServer {
  readonly received = {
    connectRequests: 0,
    tunnellingRequests: [] as Array<{ channelId: number; sequence: number; destination: number }>,
    /** Client→server TUNNELLING_ACK frames: must stay 0 in stream mode (TUN §2.6.2). */
    acks: 0,
    connectionState: 0,
    disconnectRequests: 0,
    disconnectResponses: 0,
    other: [] as number[],
    malformed: 0,
  };
  private gw: VirtualSecureGateway | null = null;
  private counter = 0;
  readonly channelId: number;
  constructor(private readonly o: StreamTunnelServerOptions = {}) { this.channelId = o.channelId ?? 5; }

  bind(gw: VirtualSecureGateway): void { this.gw = gw; }

  /** Pass as `onInner` of the gateway options. */
  readonly onInner = (s: ServerSession, frame: Buffer): void => {
    let f;
    try { f = decodeFrame(frame); } catch { this.received.malformed++; return; }
    switch (f.service) {
      case ServiceType.CONNECT_REQUEST: {
        this.received.connectRequests++;
        decodeConnectRequest(f.body);
        this.send(s, encodeConnectResponse({ channelId: this.channelId, status: StatusCode.NO_ERROR, dataEndpoint: { protocol: HostProtocol.UDP, address: NAT_HPAI.address, port: 0 }, assignedAddress: this.o.assignedAddress ?? 0xff01 }));
        return;
      }
      case ServiceType.TUNNELLING_REQUEST: {
        const r = decodeTunnellingRequest(f.body);
        const c = decodeCemi(r.cemi);
        this.received.tunnellingRequests.push({ channelId: r.channelId, sequence: r.sequence, destination: c.destination });
        if ((this.o.confirm ?? true) && c.messageCode === CemiMessageCode.L_DATA_REQ && c.group) {
          this.telegram(s, CemiMessageCode.L_DATA_CON, c.source, c.destination, c.group.service, c.group.data);
        }
        return;
      }
      case ServiceType.TUNNELLING_ACK: this.received.acks++; return;
      case ServiceType.CONNECTIONSTATE_REQUEST: this.received.connectionState++; return;
      case ServiceType.DISCONNECT_REQUEST: this.received.disconnectRequests++; return;
      case ServiceType.DISCONNECT_RESPONSE: this.received.disconnectResponses++; return;
      default: this.received.other.push(f.service);
    }
  };

  private nextSeq(): number {
    const m = this.o.sequenceMode ?? "zero";
    if (m === "zero") return 0;
    if (m === "counter") return this.counter++ & 0xff;
    return m;
  }
  private send(s: ServerSession, frame: Buffer): void { this.gw!.sendInner(s, frame); }

  /** Server→client TUNNELLING_REQUEST carrying a group telegram (L_Data.ind by default). */
  telegram(s: ServerSession, code: number, source: number, destination: number, service: GroupService, data: GroupData | null, sequence?: number): void {
    const cemi = encodeGroupCemi({ messageCode: code, source, destination, service, data });
    this.send(s, encodeTunnellingRequest({ channelId: this.channelId, sequence: sequence ?? this.nextSeq(), cemi }));
  }
  /** Arbitrary TUNNELLING_REQUEST body (malformed cEMI etc.). */
  rawTunnelling(s: ServerSession, cemi: Buffer, sequence = 0, channelId = this.channelId): void {
    this.send(s, encodeTunnellingRequest({ channelId, sequence, cemi }));
  }
  /** Server→client TUNNELLING_ACK (which a stream-mode client must ignore). */
  ack(s: ServerSession, sequence: number, status: number = StatusCode.NO_ERROR, channelId = this.channelId): void {
    this.send(s, encodeTunnellingAck({ channelId, sequence, status }));
  }
  /** Server-initiated DISCONNECT_REQUEST for the connection. */
  disconnect(s: ServerSession, channelId = this.channelId): void {
    this.send(s, encodeFrame(ServiceType.DISCONNECT_REQUEST, Buffer.concat([Buffer.from([channelId, 0]), Buffer.from([8, 1, 0, 0, 0, 0, 0, 0])])));
  }
  /** Any inner frame verbatim. */
  raw(s: ServerSession, frame: Buffer): void { this.send(s, frame); }
}
