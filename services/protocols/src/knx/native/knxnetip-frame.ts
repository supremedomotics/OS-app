/**
 * KNXnet/IP frame codec (§ Clean-room KNX stack — framing). Pure functions over
 * `Buffer`s, written from the published KNXnet/IP Core and Tunnelling specifications. No
 * sockets, no timers, no SupremeOS types: the session layer (tunnel-client.ts) and the
 * virtual bus (simulator) both build on exactly this module, so a frame the simulator
 * accepts is a frame the real client emits and vice versa.
 *
 * Decoding is strict and total: every malformed input yields a thrown
 * {@link KnxFrameError} with a machine-readable `code`, never an out-of-bounds read, an
 * infinite loop or a silently-truncated result. Inputs are untrusted network data.
 */

export const KNXNETIP_HEADER_SIZE = 0x06;
export const KNXNETIP_VERSION = 0x10;
export const HPAI_SIZE = 8;
/** UDP datagram upper bound the stack will accept; real KNXnet/IP frames are < 256. */
export const MAX_FRAME_SIZE = 508;

export const ServiceType = {
  SEARCH_REQUEST: 0x0201,
  SEARCH_RESPONSE: 0x0202,
  DESCRIPTION_REQUEST: 0x0203,
  DESCRIPTION_RESPONSE: 0x0204,
  CONNECT_REQUEST: 0x0205,
  CONNECT_RESPONSE: 0x0206,
  CONNECTIONSTATE_REQUEST: 0x0207,
  CONNECTIONSTATE_RESPONSE: 0x0208,
  DISCONNECT_REQUEST: 0x0209,
  DISCONNECT_RESPONSE: 0x020a,
  TUNNELLING_REQUEST: 0x0420,
  TUNNELLING_ACK: 0x0421,
  ROUTING_INDICATION: 0x0530,
  ROUTING_LOST_MESSAGE: 0x0531,
  ROUTING_BUSY: 0x0532,
} as const;
export type ServiceTypeCode = (typeof ServiceType)[keyof typeof ServiceType];

const KNOWN_SERVICES: ReadonlySet<number> = new Set(Object.values(ServiceType));

/** KNXnet/IP status / error codes (Core spec §7.8). */
export const StatusCode = {
  NO_ERROR: 0x00,
  HOST_PROTOCOL_TYPE: 0x01,
  VERSION_NOT_SUPPORTED: 0x02,
  SEQUENCE_NUMBER: 0x04,
  CONNECTION_ID: 0x21,
  CONNECTION_TYPE: 0x22,
  CONNECTION_OPTION: 0x23,
  NO_MORE_CONNECTIONS: 0x24,
  NO_MORE_UNIQUE_CONNECTIONS: 0x25,
  DATA_CONNECTION: 0x26,
  KNX_CONNECTION: 0x27,
  TUNNELLING_LAYER: 0x29,
} as const;

const STATUS_TEXT = new Map<number, string>([
  [0x00, "no error"],
  [0x01, "host protocol type not supported"],
  [0x02, "protocol version not supported"],
  [0x04, "sequence number out of order"],
  [0x21, "no active connection with this channel id"],
  [0x22, "connection type not supported"],
  [0x23, "connection option not supported"],
  [0x24, "no more connections available (all tunnel slots are in use)"],
  [0x25, "no more unique connections available"],
  [0x26, "error in data connection"],
  [0x27, "error in KNX subnetwork connection"],
  [0x29, "tunnelling layer not supported"],
]);

export function describeStatus(code: number): string {
  return STATUS_TEXT.get(code) ?? `unknown status 0x${code.toString(16).padStart(2, "0")}`;
}

export const HostProtocol = { UDP: 0x01, TCP: 0x02 } as const;
export const ConnectionType = { DEVICE_MGMT: 0x03, TUNNEL: 0x04 } as const;
/** Tunnelling KNX layer. Only link layer is used for group communication. */
export const TunnelLayer = { LINK: 0x02, RAW: 0x04, BUSMONITOR: 0x80 } as const;

export type KnxFrameErrorCode =
  | "too_short" | "bad_header_size" | "unsupported_version" | "length_mismatch"
  | "frame_too_large" | "unknown_service" | "bad_structure" | "unsupported_protocol";

export class KnxFrameError extends Error {
  constructor(readonly code: KnxFrameErrorCode, message: string) {
    super(message);
    this.name = "KnxFrameError";
  }
}

export interface Hpai {
  protocol: number;
  address: string;
  port: number;
}

/** A route-back HPAI (0.0.0.0:0) tells the server to answer to the datagram's source
 * address — the only form that works through NAT, and what the stack sends by default. */
export const NAT_HPAI: Hpai = { protocol: HostProtocol.UDP, address: "0.0.0.0", port: 0 };

export function encodeHpai(h: Hpai): Buffer {
  const b = Buffer.alloc(HPAI_SIZE);
  b[0] = HPAI_SIZE;
  b[1] = h.protocol;
  const octets = parseIPv4(h.address);
  for (let i = 0; i < 4; i++) b[2 + i] = octets[i]!;
  if (!Number.isInteger(h.port) || h.port < 0 || h.port > 0xffff) throw new KnxFrameError("bad_structure", `HPAI port ${h.port} out of range`);
  b.writeUInt16BE(h.port, 6);
  return b;
}

export function decodeHpai(buf: Buffer, offset: number): Hpai {
  if (buf.length < offset + HPAI_SIZE) throw new KnxFrameError("too_short", "truncated HPAI");
  if (buf[offset] !== HPAI_SIZE) throw new KnxFrameError("bad_structure", `HPAI length ${buf[offset]} != 8`);
  const protocol = buf[offset + 1]!;
  if (protocol !== HostProtocol.UDP) throw new KnxFrameError("unsupported_protocol", `HPAI host protocol 0x${protocol.toString(16)} is not UDP`);
  const address = `${buf[offset + 2]}.${buf[offset + 3]}.${buf[offset + 4]}.${buf[offset + 5]}`;
  return { protocol, address, port: buf.readUInt16BE(offset + 6) };
}

function parseIPv4(text: string): number[] {
  const p = text.split(".");
  if (p.length !== 4) throw new KnxFrameError("bad_structure", `invalid IPv4 address "${text}"`);
  return p.map((s) => {
    if (!/^(0|[1-9]\d{0,2})$/.test(s) || Number(s) > 255) throw new KnxFrameError("bad_structure", `invalid IPv4 address "${text}"`);
    return Number(s);
  });
}

// ---------------------------------------------------------------------------------------
// Frame envelope

export interface RawFrame {
  service: number;
  /** Everything after the 6-byte header. */
  body: Buffer;
}

export function encodeFrame(service: number, body: Buffer): Buffer {
  const total = KNXNETIP_HEADER_SIZE + body.length;
  if (total > MAX_FRAME_SIZE) throw new KnxFrameError("frame_too_large", `frame of ${total} bytes exceeds ${MAX_FRAME_SIZE}`);
  const out = Buffer.alloc(total);
  out[0] = KNXNETIP_HEADER_SIZE;
  out[1] = KNXNETIP_VERSION;
  out.writeUInt16BE(service, 2);
  out.writeUInt16BE(total, 4);
  body.copy(out, KNXNETIP_HEADER_SIZE);
  return out;
}

/** Validates the envelope only (header size, version, declared length == datagram length,
 * known service). Body structure is validated by the typed decoders below. */
export function decodeFrame(buf: Buffer): RawFrame {
  if (buf.length < KNXNETIP_HEADER_SIZE) throw new KnxFrameError("too_short", `${buf.length} bytes is shorter than a KNXnet/IP header`);
  if (buf.length > MAX_FRAME_SIZE) throw new KnxFrameError("frame_too_large", `${buf.length}-byte datagram exceeds ${MAX_FRAME_SIZE}`);
  if (buf[0] !== KNXNETIP_HEADER_SIZE) throw new KnxFrameError("bad_header_size", `header size byte 0x${buf[0]!.toString(16)} != 0x06`);
  if (buf[1] !== KNXNETIP_VERSION) throw new KnxFrameError("unsupported_version", `protocol version 0x${buf[1]!.toString(16)} != 0x10`);
  const service = buf.readUInt16BE(2);
  const total = buf.readUInt16BE(4);
  if (total !== buf.length) throw new KnxFrameError("length_mismatch", `declared length ${total} != datagram length ${buf.length}`);
  if (!KNOWN_SERVICES.has(service)) throw new KnxFrameError("unknown_service", `unknown service type 0x${service.toString(16).padStart(4, "0")}`);
  return { service, body: buf.subarray(KNXNETIP_HEADER_SIZE) };
}

// ---------------------------------------------------------------------------------------
// Typed messages

export interface ConnectRequest { controlEndpoint: Hpai; dataEndpoint: Hpai; layer: number }
export interface ConnectResponse {
  channelId: number;
  status: number;
  /** Present only when `status === NO_ERROR`. */
  dataEndpoint?: Hpai;
  /** KNX individual address the server assigned to this tunnel (raw 16-bit). */
  assignedAddress?: number;
}
export interface ChannelRequest { channelId: number; endpoint: Hpai }
export interface ChannelResponse { channelId: number; status: number }
export interface TunnellingRequest { channelId: number; sequence: number; cemi: Buffer }
export interface TunnellingAck { channelId: number; sequence: number; status: number }

export function encodeConnectRequest(r: ConnectRequest): Buffer {
  const cri = Buffer.from([0x04, ConnectionType.TUNNEL, r.layer, 0x00]);
  return encodeFrame(ServiceType.CONNECT_REQUEST, Buffer.concat([encodeHpai(r.controlEndpoint), encodeHpai(r.dataEndpoint), cri]));
}

export function decodeConnectRequest(body: Buffer): ConnectRequest {
  if (body.length !== HPAI_SIZE * 2 + 4) throw new KnxFrameError("length_mismatch", `CONNECT_REQUEST body is ${body.length} bytes, expected 20`);
  const cri = body.subarray(16);
  if (cri[0] !== 4 || cri[1] !== ConnectionType.TUNNEL) throw new KnxFrameError("bad_structure", "CONNECT_REQUEST CRI is not a 4-byte tunnel CRI");
  return { controlEndpoint: decodeHpai(body, 0), dataEndpoint: decodeHpai(body, 8), layer: cri[2]! };
}

export function encodeConnectResponse(r: ConnectResponse): Buffer {
  if (r.status !== StatusCode.NO_ERROR) return encodeFrame(ServiceType.CONNECT_RESPONSE, Buffer.from([r.channelId, r.status]));
  if (!r.dataEndpoint || r.assignedAddress === undefined) throw new KnxFrameError("bad_structure", "successful CONNECT_RESPONSE requires dataEndpoint and assignedAddress");
  const crd = Buffer.alloc(4);
  crd[0] = 4; crd[1] = ConnectionType.TUNNEL; crd.writeUInt16BE(r.assignedAddress, 2);
  return encodeFrame(ServiceType.CONNECT_RESPONSE, Buffer.concat([Buffer.from([r.channelId, r.status]), encodeHpai(r.dataEndpoint), crd]));
}

export function decodeConnectResponse(body: Buffer): ConnectResponse {
  if (body.length < 2) throw new KnxFrameError("too_short", "CONNECT_RESPONSE shorter than channel+status");
  const channelId = body[0]!, status = body[1]!;
  // Error responses legitimately carry nothing (or only a stub) after status.
  if (status !== StatusCode.NO_ERROR) return { channelId, status };
  if (body.length !== 2 + HPAI_SIZE + 4) throw new KnxFrameError("length_mismatch", `CONNECT_RESPONSE body is ${body.length} bytes, expected 14`);
  const crd = body.subarray(10);
  if (crd[0] !== 4 || crd[1] !== ConnectionType.TUNNEL) throw new KnxFrameError("bad_structure", "CONNECT_RESPONSE CRD is not a 4-byte tunnel CRD");
  return { channelId, status, dataEndpoint: decodeHpai(body, 2), assignedAddress: crd.readUInt16BE(2) };
}

function encodeChannelRequest(service: number, r: ChannelRequest): Buffer {
  return encodeFrame(service, Buffer.concat([Buffer.from([r.channelId, 0x00]), encodeHpai(r.endpoint)]));
}
function decodeChannelRequest(body: Buffer): ChannelRequest {
  if (body.length !== 2 + HPAI_SIZE) throw new KnxFrameError("length_mismatch", `channel request body is ${body.length} bytes, expected 10`);
  return { channelId: body[0]!, endpoint: decodeHpai(body, 2) };
}
function encodeChannelResponse(service: number, r: ChannelResponse): Buffer {
  return encodeFrame(service, Buffer.from([r.channelId, r.status]));
}
function decodeChannelResponse(body: Buffer): ChannelResponse {
  if (body.length !== 2) throw new KnxFrameError("length_mismatch", `channel response body is ${body.length} bytes, expected 2`);
  return { channelId: body[0]!, status: body[1]! };
}

export const encodeConnectionStateRequest = (r: ChannelRequest): Buffer => encodeChannelRequest(ServiceType.CONNECTIONSTATE_REQUEST, r);
export const decodeConnectionStateRequest = decodeChannelRequest;
export const encodeConnectionStateResponse = (r: ChannelResponse): Buffer => encodeChannelResponse(ServiceType.CONNECTIONSTATE_RESPONSE, r);
export const decodeConnectionStateResponse = decodeChannelResponse;
export const encodeDisconnectRequest = (r: ChannelRequest): Buffer => encodeChannelRequest(ServiceType.DISCONNECT_REQUEST, r);
export const decodeDisconnectRequest = decodeChannelRequest;
export const encodeDisconnectResponse = (r: ChannelResponse): Buffer => encodeChannelResponse(ServiceType.DISCONNECT_RESPONSE, r);
export const decodeDisconnectResponse = decodeChannelResponse;

const CONN_HEADER_SIZE = 4;

export function encodeTunnellingRequest(r: TunnellingRequest): Buffer {
  const hdr = Buffer.from([CONN_HEADER_SIZE, r.channelId, r.sequence & 0xff, 0x00]);
  return encodeFrame(ServiceType.TUNNELLING_REQUEST, Buffer.concat([hdr, r.cemi]));
}

export function decodeTunnellingRequest(body: Buffer): TunnellingRequest {
  if (body.length < CONN_HEADER_SIZE) throw new KnxFrameError("too_short", "TUNNELLING_REQUEST shorter than its connection header");
  if (body[0] !== CONN_HEADER_SIZE) throw new KnxFrameError("bad_structure", `connection header length ${body[0]} != 4`);
  const cemi = Buffer.from(body.subarray(CONN_HEADER_SIZE));
  if (cemi.length === 0) throw new KnxFrameError("too_short", "TUNNELLING_REQUEST carries no cEMI frame");
  return { channelId: body[1]!, sequence: body[2]!, cemi };
}

export function encodeTunnellingAck(r: TunnellingAck): Buffer {
  return encodeFrame(ServiceType.TUNNELLING_ACK, Buffer.from([CONN_HEADER_SIZE, r.channelId, r.sequence & 0xff, r.status]));
}

export function decodeTunnellingAck(body: Buffer): TunnellingAck {
  if (body.length !== CONN_HEADER_SIZE) throw new KnxFrameError("length_mismatch", `TUNNELLING_ACK body is ${body.length} bytes, expected 4`);
  if (body[0] !== CONN_HEADER_SIZE) throw new KnxFrameError("bad_structure", `connection header length ${body[0]} != 4`);
  return { channelId: body[1]!, sequence: body[2]!, status: body[3]! };
}

export function encodeSearchRequest(discoveryEndpoint: Hpai): Buffer {
  return encodeFrame(ServiceType.SEARCH_REQUEST, encodeHpai(discoveryEndpoint));
}

export function decodeSearchRequest(body: Buffer): Hpai {
  if (body.length !== HPAI_SIZE) throw new KnxFrameError("length_mismatch", `SEARCH_REQUEST body is ${body.length} bytes, expected 8`);
  return decodeHpai(body, 0);
}
