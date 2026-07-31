import dgram from "node:dgram";
import {
  CASAMBI_NODE_STATUS_REQUEST,
  decodeCasambiPacket,
  encodeCasambiPacket,
  encodeNodeStatusRequest,
  type CasambiPacket,
  type CasambiWireFormat,
} from "./udp-codec.js";

/**
 * Casambi Local Gateway — UDP Engine (§ Casambi Driver Refactor — PR-2, Local Gateway
 * Foundation). Real "UDP Casambi Command" transport (`udp-codec.ts`'s wire format), grounded in
 * `Lithernet_UDP_Developer_Reference.pdf` §5.10. Per the gateway's own config (p.80), send and
 * receive share one UDP port — this engine binds that port and both sends commands to, and
 * decodes notifications from, the same `gatewayIp:udpPort` peer.
 *
 * The socket is injectable (`socketFactory`) so unit tests can exercise real encode/decode/
 * lifecycle behavior without a live gateway on the network, matching the Cloud transport's own
 * injectable-transport testing pattern.
 */

/** Minimal surface of `node:dgram`'s `Socket` this engine depends on — lets tests supply a fake. */
export interface CasambiUdpSocketLike {
  send(msg: string, port: number, address: string, callback?: (error: Error | null) => void): void;
  on(event: "message", listener: (msg: Buffer, rinfo: { address: string; port: number }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "listening", listener: () => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  bind(port?: number): void;
  close(callback?: () => void): void;
}

export type CasambiUdpSocketFactory = () => CasambiUdpSocketLike;

export interface CasambiUdpEngineOptions {
  gatewayIp: string;
  udpPort: number;
  /** This bridge's own Net ID (0-254), used as the source `Net_ID` on every outgoing command. */
  netId: number;
  /** Wire text format — must match the gateway's own "DEC or HEX" setting. Default `hex-dot`
   * (the gateway's own factory default, p.80 screenshot). */
  format?: CasambiWireFormat;
  /** Local port to bind for receiving. Defaults to `udpPort` (the gateway both sends and
   * receives on the configured port, p.80). */
  localPort?: number;
  /** Injectable for tests — defaults to a real `node:dgram` UDP4 socket. */
  socketFactory?: CasambiUdpSocketFactory;
}

/** A decoded incoming UDP notification, paired with its raw wire text and sender info. */
export interface CasambiUdpPacket {
  readonly raw: string;
  readonly packet: CasambiPacket;
  readonly rinfo: { address: string; port: number };
}

export class CasambiUdpEngine {
  private readonly opts: Required<Pick<CasambiUdpEngineOptions, "gatewayIp" | "udpPort" | "netId">> &
    CasambiUdpEngineOptions;
  private socket: CasambiUdpSocketLike | null = null;
  private readonly packetListeners = new Set<(packet: CasambiUdpPacket) => void>();
  private readonly errorListeners = new Set<(err: Error) => void>();
  private readonly decodeErrorListeners = new Set<(raw: string, err: Error) => void>();
  private _listening = false;

  constructor(opts: CasambiUdpEngineOptions) {
    this.opts = opts;
  }

  get gatewayIp(): string {
    return this.opts.gatewayIp;
  }

  get udpPort(): number {
    return this.opts.udpPort;
  }

  get format(): CasambiWireFormat {
    return this.opts.format ?? "hex-dot";
  }

  /** True once the local UDP socket is bound and receiving. */
  get listening(): boolean {
    return this._listening;
  }

  async start(): Promise<void> {
    if (this.socket) return; // idempotent, matching every other transport's start()
    const factory = this.opts.socketFactory ?? (() => dgram.createSocket("udp4") as unknown as CasambiUdpSocketLike);
    const socket = factory();
    socket.on("message", (msg, rinfo) => this.handleMessage(msg, rinfo));
    socket.on("error", (err) => this.emitError(err));
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const onListening = () => {
        if (settled) return;
        settled = true;
        this._listening = true;
        resolve();
      };
      socket.on("error", onError);
      socket.on("listening", onListening);
      socket.bind(this.opts.localPort ?? this.opts.udpPort);
    });
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this._listening = false;
    if (!socket) return;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  onPacket(listener: (packet: CasambiUdpPacket) => void): () => void {
    this.packetListeners.add(listener);
    return () => this.packetListeners.delete(listener);
  }

  /** Socket-level errors (bind failures, ICMP unreachable, etc). */
  onError(listener: (err: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** Malformed/undecodable incoming datagrams — kept distinct from `onError` since these are
   * per-packet parse failures, not a broken socket. */
  onDecodeError(listener: (raw: string, err: Error) => void): () => void {
    this.decodeErrorListeners.add(listener);
    return () => this.decodeErrorListeners.delete(listener);
  }

  /** Send a pre-built packet (its `netId`/`direction` are used verbatim — callers typically pass
   * one of `udp-codec.ts`'s `encodeXxx()` builders). */
  async send(packet: CasambiPacket): Promise<void> {
    if (!this.socket) throw new Error("casambi: UDP engine send() called before start()");
    const text = encodeCasambiPacket(packet, this.format);
    const socket = this.socket;
    await new Promise<void>((resolve, reject) => {
      socket.send(text, this.opts.udpPort, this.opts.gatewayIp, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Safe reachability probe for the Setup Wizard's "Test Connection" action and the Driver
   * Health Engine's periodic heartbeat. Per the PR-2 brief, Local mode must never actuate a real
   * device just to check connectivity — this uses opcode 0x39 Node Status with `Request=0xFF`
   * ("own node", p.300), the one documented request value that queries the gateway itself rather
   * than any device, group, or scene, so it can never change real light/device state. Resolves
   * `true` on any 0x39/0x3A response within `timeoutMs`, `false` on timeout or send failure.
   */
  async probe(timeoutMs = 3_000): Promise<boolean> {
    if (!this.socket) throw new Error("casambi: UDP engine probe() called before start()");
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      };
      const unsubscribe = this.onPacket((pkt) => {
        if (pkt.packet.opcode === 0x39 || pkt.packet.opcode === 0x3a) settle(true);
      });
      const timer = setTimeout(() => settle(false), timeoutMs);
      this.send(encodeNodeStatusRequest(this.opts.netId, CASAMBI_NODE_STATUS_REQUEST.ownNode)).catch(() => settle(false));
    });
  }

  private handleMessage(msg: Buffer, rinfo: { address: string; port: number }): void {
    const raw = msg.toString("ascii");
    let packet: CasambiPacket;
    try {
      packet = decodeCasambiPacket(raw, this.format);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const listener of this.decodeErrorListeners) listener(raw, error);
      return;
    }
    for (const listener of this.packetListeners) listener({ raw, packet, rinfo });
  }

  private emitError(err: Error): void {
    for (const listener of this.errorListeners) listener(err);
  }
}
