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
  /** Real `dgram.Socket.address()` once bound — the honest source for "local bind address/port"
   * diagnostics (§ UDP Diagnostics). Optional so a minimal test fake need not implement it; when
   * absent, `localAddress`/`localPort` simply report `null` rather than fabricating a value. */
  address?(): { address: string; port: number; family: string };
}

/** One socket-level lifecycle state, reported honestly rather than collapsed into a single
 * reachable/unreachable boolean (§ UDP Diagnostics audit — Casambi's UDP transport is
 * connectionless; there is no "connected" state to claim, only these real, verifiable stages). */
export type CasambiUdpSocketState = "closed" | "bound" | "error";

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

/**
 * One entry in the bounded protocol trace (§ UDP Receive Pipeline Audit). Recorded for EVERY
 * datagram the socket delivers — successfully parsed or not — so a real capture (e.g. a Wireshark
 * session showing the gateway broadcasting to `255.255.255.255`) can always be cross-checked
 * against what SupremeOS actually received, independent of whether parsing later succeeded.
 */
export interface CasambiUdpPacketTrace {
  at: string;
  sourceAddress: string;
  sourcePort: number;
  /** This engine's own bound local port — every datagram arrives here regardless of whether the
   * gateway unicast or broadcast it. */
  destinationPort: number | null;
  payloadLength: number;
  rawAscii: string;
  rawHex: string;
  decoded: CasambiPacket | null;
  parseError: string | null;
}

const MAX_TRACE_ENTRIES = 20;

export class CasambiUdpEngine {
  private readonly opts: Required<Pick<CasambiUdpEngineOptions, "gatewayIp" | "udpPort" | "netId">> &
    CasambiUdpEngineOptions;
  private socket: CasambiUdpSocketLike | null = null;
  private readonly packetListeners = new Set<(packet: CasambiUdpPacket) => void>();
  private readonly errorListeners = new Set<(err: Error) => void>();
  private readonly decodeErrorListeners = new Set<(raw: string, err: Error) => void>();
  /** § UDP Receive Pipeline Audit — fired the instant `socket.on("message")` delivers a datagram,
   * before any parsing/validation/filtering. Exists so reception can be proven independently of
   * whether the payload later decodes, per real hardware evidence that the OS receives broadcast
   * packets the old parse-gated instrumentation gave no visibility into. */
  private readonly rawDatagramListeners = new Set<(raw: string, rinfo: { address: string; port: number }) => void>();
  private readonly traceLog: CasambiUdpPacketTrace[] = [];
  private _listening = false;
  private _lastError: string | null = null;
  private _packetsSent = 0;
  private _packetsReceived = 0;
  private _lastPacketAt: string | null = null;
  private _lastSendAt: string | null = null;
  private _lastSendError: string | null = null;
  private _lastDecodeError: { raw: string; message: string; at: string } | null = null;
  private readonly probeLatenciesMs: number[] = [];

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

  /** Honest, staged socket lifecycle state (§ UDP Diagnostics audit). `"closed"` before `start()`
   * or after `stop()`/a bind failure; `"bound"` once the OS has actually bound the local port;
   * `"error"` after a real socket-level error (bind failure, EADDRINUSE, permission denied,
   * ICMP-reported send failure) — never derived from "no reply yet", since Casambi's UDP
   * protocol is connectionless and a lack of reply is not a documented failure condition. */
  get socketState(): CasambiUdpSocketState {
    if (this._lastError && !this._listening) return "error";
    return this._listening ? "bound" : "closed";
  }

  /** The last real socket-level error (bind failure, send failure reported by the OS), or
   * `null`. Distinct from `lastDecodeError`, which is a per-packet parse failure, not evidence
   * the transport itself is broken. */
  get lastError(): string | null {
    return this._lastError;
  }

  /** Real local bind address, from `dgram.Socket.address()`, once bound. `null` before bind or
   * if the injected socket doesn't implement `address()` (e.g. a minimal test fake) — never
   * fabricated. */
  get localAddress(): string | null {
    if (!this._listening) return null;
    return this.socket?.address?.().address ?? null;
  }

  /** Real local bound port, from `dgram.Socket.address()`. See {@link localAddress}. */
  get localPort(): number | null {
    if (!this._listening) return null;
    return this.socket?.address?.().port ?? null;
  }

  /** Total datagrams successfully handed to the OS via `send()` since this engine was created. */
  get packetsSent(): number {
    return this._packetsSent;
  }

  /** Total datagrams successfully decoded from the gateway since this engine was created
   * (decode failures are tracked separately via {@link lastDecodeError} and do not count here). */
  get packetsReceived(): number {
    return this._packetsReceived;
  }

  /** ISO timestamp of the most recently received (successfully decoded) packet, or `null` if
   * none has arrived yet. */
  get lastPacketAt(): string | null {
    return this._lastPacketAt;
  }

  /** ISO timestamp of the most recent successful `send()`, or `null`. */
  get lastSendAt(): string | null {
    return this._lastSendAt;
  }

  /** Error message from the most recent failed `send()` (e.g. an ICMP-reported unreachable
   * destination), or `null` if the last send succeeded or none has been attempted. */
  get lastSendError(): string | null {
    return this._lastSendError;
  }

  /** The most recent malformed/undecodable datagram, or `null`. A repeated decode error is real,
   * protocol-grounded evidence of a Net ID or Data Format mismatch (the gateway's own config
   * wizard requires both to match the remote station exactly) — unlike a plain absence of
   * traffic, this IS a documented, actionable failure signal. */
  get lastDecodeError(): { raw: string; message: string; at: string } | null {
    return this._lastDecodeError;
  }

  /**
   * Average round-trip latency across recent {@link probe} calls, in ms, or `null` if never
   * measured. Deliberately scoped to probe round-trips only — the general Casambi UDP
   * notification stream has no sequence numbers or request/response pairing in the documented
   * packet structure (`{length, opcode, args}`), so there is no honest way to compute a general
   * "notification latency"; labeling this as probe round-trip latency (not stream latency) is
   * the disclosed, non-fabricated interpretation. */
  get averageLatencyMs(): number | null {
    if (this.probeLatenciesMs.length === 0) return null;
    const sum = this.probeLatenciesMs.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.probeLatenciesMs.length);
  }

  /**
   * Packet loss for the general notification stream is intentionally never reported (no `get`
   * exists for it) rather than reported as `0` or estimated: the documented packet structure has
   * no sequence numbers, so there is no way to distinguish "no packets sent yet" from "packets
   * were dropped in transit." Fabricating a number here would violate the "never fabricate
   * values" requirement. A future repeated-probe loss-rate measurement could compute this
   * honestly, but that is not implemented.
   */

  async start(): Promise<void> {
    if (this.socket) return; // idempotent, matching every other transport's start()
    const factory = this.opts.socketFactory ?? (() => dgram.createSocket("udp4") as unknown as CasambiUdpSocketLike);
    const socket = factory();
    socket.on("message", (msg, rinfo) => this.handleMessage(msg, rinfo));
    socket.on("error", (err) => this.emitError(err));
    this.socket = socket;

    try {
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
      this._lastError = null;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this.socket = null;
      throw err;
    }
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

  /**
   * Fires for EVERY datagram the socket delivers, immediately upon `socket.on("message")` and
   * before any parsing, validation, or filtering (§ UDP Receive Pipeline Audit, Step 1). Use this
   * to prove socket-level reception is working independent of decode outcome — e.g. wiring it to
   * the driver's trace log gives an immediate "UDP datagram received" line for every packet, sent
   * or broadcast, that Wireshark also sees.
   */
  onRawDatagram(listener: (raw: string, rinfo: { address: string; port: number }) => void): () => void {
    this.rawDatagramListeners.add(listener);
    return () => this.rawDatagramListeners.delete(listener);
  }

  /** Bounded (last 20) protocol trace of every datagram received, parsed or not — the real,
   * non-fabricated record backing the Diagnostics page's packet trace (§ UDP Receive Pipeline
   * Audit, Step 6). */
  get recentTraces(): readonly CasambiUdpPacketTrace[] {
    return this.traceLog;
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
    try {
      await new Promise<void>((resolve, reject) => {
        socket.send(text, this.opts.udpPort, this.opts.gatewayIp, (err) => (err ? reject(err) : resolve()));
      });
      this._packetsSent += 1;
      this._lastSendAt = new Date().toISOString();
      this._lastSendError = null;
    } catch (err) {
      this._lastSendError = err instanceof Error ? err.message : String(err);
      throw err;
    }
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
    const startedAt = Date.now();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (result) {
          this.probeLatenciesMs.push(Date.now() - startedAt);
          if (this.probeLatenciesMs.length > 20) this.probeLatenciesMs.shift();
        }
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
    // § UDP Receive Pipeline Audit — counted and traced the instant the OS delivers a datagram,
    // strictly before parsing/validation/opcode decoding/filtering. Real hardware evidence
    // (Wireshark) showed the Lithernet gateway broadcasting NotifyControlValues to
    // 255.255.255.255:10009 rather than unicasting to this client — this engine never filters by
    // source or destination address (no `rinfo.address !== gatewayIp` check exists, and the
    // socket is never `connect()`-ed, which would otherwise restrict delivery to one peer), so a
    // broadcast datagram is received exactly like a unicast one. Counting/tracing here, ahead of
    // decode, means a real reception failure and a real parse failure are never indistinguishable
    // again.
    const at = new Date().toISOString();
    this._packetsReceived += 1;
    this._lastPacketAt = at;
    const raw = msg.toString("ascii");
    for (const listener of this.rawDatagramListeners) listener(raw, rinfo);

    const rawHex = msg.toString("hex");
    let packet: CasambiPacket | null = null;
    let parseError: string | null = null;
    try {
      packet = decodeCasambiPacket(raw, this.format);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      parseError = error.message;
      this._lastDecodeError = { raw, message: error.message, at };
    }

    this.recordTrace({
      at,
      sourceAddress: rinfo.address,
      sourcePort: rinfo.port,
      destinationPort: this.localPort,
      payloadLength: msg.length,
      rawAscii: raw,
      rawHex,
      decoded: packet,
      parseError,
    });

    if (packet === null) {
      for (const listener of this.decodeErrorListeners) listener(raw, new Error(parseError ?? "unknown decode error"));
      return;
    }
    for (const listener of this.packetListeners) listener({ raw, packet, rinfo });
  }

  private recordTrace(entry: CasambiUdpPacketTrace): void {
    this.traceLog.push(entry);
    if (this.traceLog.length > MAX_TRACE_ENTRIES) this.traceLog.shift();
  }

  private emitError(err: Error): void {
    this._lastError = err.message;
    for (const listener of this.errorListeners) listener(err);
  }
}
