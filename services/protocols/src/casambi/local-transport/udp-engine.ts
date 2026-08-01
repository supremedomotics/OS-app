import { LocalDirectUdpTransport, NatsUdpTransportClient, type UdpTransport, type UdpTransportFactory } from "@supreme/lan";
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
 * Foundation; § LAN Transport Phase 2 — Casambi migrated off direct socket ownership). Real "UDP
 * Casambi Command" wire-format logic (`udp-codec.ts`), grounded in `Lithernet_UDP_Developer_
 * Reference.pdf` §5.10. Per the gateway's own config (p.80), send and receive share one UDP port
 * — this engine binds that port and both sends commands to, and decodes notifications from, the
 * same `gatewayIp:udpPort` peer.
 *
 * This class NO LONGER owns a raw socket, opens `node:dgram` itself, or defines any
 * protocol-specific socket interface — the earlier `CasambiUdpSocketLike`/`CasambiUdpSocketFactory`
 * abstraction (and the `dgram.createSocket()` default that lived inside this file) is gone
 * entirely, per `docs/architecture/adr/0022-supreme-lan-transport-service.md`'s Phase 2. All raw
 * LAN transport now comes from `@supreme/lan`'s generic, protocol-agnostic `UdpTransport`
 * interface, injected via `udpTransportFactory` — either `NatsUdpTransportClient` (a real
 * `supreme-lan` service reachable over NATS) or `LocalDirectUdpTransport` (real `node:dgram`,
 * same process, no NATS hop — used when no separate `supreme-lan` deployment exists). Which one is
 * chosen is decided once, centrally, by `services/gateway/src/installer-context.ts`'s
 * `nativeDriverContext()` — never by this file.
 *
 * Every method/getter below keeps its EXACT prior public shape (same names, same return types) —
 * `command-engine.ts`, `discovery-engine.ts`, and `casambi-driver.ts` call this engine exactly as
 * they always have; only what happens *inside* `start()`/`send()`/`stop()` changed.
 */

/** One socket-level lifecycle state, reported honestly rather than collapsed into a single
 * reachable/unreachable boolean (§ UDP Diagnostics audit — Casambi's UDP transport is
 * connectionless; there is no "connected" state to claim, only these real, verifiable stages). */
export type CasambiUdpSocketState = "closed" | "bound" | "error";

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
  /** Factory for the generic `UdpTransport` this engine sends/receives through (§ LAN Transport
   * Phase 2). REQUIRED — there is no default socket construction left inside this package;
   * callers (ultimately `services/gateway/src/native-driver-factory.ts`) always supply one
   * explicitly, real or fake. */
  udpTransportFactory: UdpTransportFactory;
}

/** A decoded incoming UDP notification, paired with its raw wire text and sender info. */
export interface CasambiUdpPacket {
  readonly raw: string;
  readonly packet: CasambiPacket;
  readonly rinfo: { address: string; port: number };
}

/**
 * One entry in the bounded protocol trace (§ UDP Receive Pipeline Audit). Recorded for EVERY
 * datagram the transport delivers — successfully parsed or not — so a real capture (e.g. a
 * Wireshark session showing the gateway broadcasting to `255.255.255.255`) can always be
 * cross-checked against what SupremeOS actually received, independent of whether parsing later
 * succeeded.
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

/**
 * § LAN Transport Phase 2 — Transport Monitor. Real, non-fabricated diagnostics read straight off
 * whichever concrete `UdpTransport` this engine is currently bound to, so the Transport Monitor
 * can show the packet counts each LAYER independently believes it has seen (transport vs. this
 * adapter vs. the driver) — the exact cross-layer view the "never guess, identify the exact
 * failing stage" failure-handling requirement needs. `backend` is derived from the concrete
 * class (`NatsUdpTransportClient` vs `LocalDirectUdpTransport`) rather than reported by config,
 * since which one is ACTUALLY in use is itself a fact worth verifying, not assuming. A transport
 * that is neither (e.g. a test's fake `UdpTransport`) reports `"unknown"` — never guessed as one
 * of the two real backends.
 */
export interface CasambiUdpTransportDiagnostics {
  backend: "local-direct" | "nats" | "unknown";
  packetsSent: number | null;
  packetsReceived: number | null;
  lastError: string | null;
}

export class CasambiUdpEngine {
  private readonly opts: CasambiUdpEngineOptions;
  private transport: UdpTransport | null = null;
  private unsubMessage: (() => void) | null = null;
  private unsubError: (() => void) | null = null;
  private readonly packetListeners = new Set<(packet: CasambiUdpPacket) => void>();
  private readonly errorListeners = new Set<(err: Error) => void>();
  private readonly decodeErrorListeners = new Set<(raw: string, err: Error) => void>();
  /** § UDP Receive Pipeline Audit — fired the instant the transport delivers a datagram, before
   * any parsing/validation/filtering. Exists so reception can be proven independently of whether
   * the payload later decodes, per real hardware evidence that the OS receives broadcast packets
   * the old parse-gated instrumentation gave no visibility into. */
  private readonly rawDatagramListeners = new Set<(raw: string, rinfo: { address: string; port: number }) => void>();
  private readonly traceLog: CasambiUdpPacketTrace[] = [];
  private _listening = false;
  private _lastError: string | null = null;
  private _packetsSent = 0;
  private _packetsReceived = 0;
  private _decodedCount = 0;
  private _decodeFailureCount = 0;
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

  /** True once the local UDP transport is bound and receiving. */
  get listening(): boolean {
    return this._listening;
  }

  /** Honest, staged transport lifecycle state (§ UDP Diagnostics audit). `"closed"` before
   * `start()` or after `stop()`/a bind failure; `"bound"` once the transport has actually bound
   * the local port; `"error"` after a real transport-level error (bind failure, EADDRINUSE,
   * permission denied, ICMP-reported send failure) — never derived from "no reply yet", since
   * Casambi's UDP protocol is connectionless and a lack of reply is not a documented failure
   * condition. */
  get socketState(): CasambiUdpSocketState {
    if (this._lastError && !this._listening) return "error";
    return this._listening ? "bound" : "closed";
  }

  /** The last real transport-level error (bind failure, send failure reported by the OS), or
   * `null`. Distinct from `lastDecodeError`, which is a per-packet parse failure, not evidence
   * the transport itself is broken. */
  get lastError(): string | null {
    return this._lastError;
  }

  /** Real local bind address, from the transport's own `address()`, once bound. `null` before
   * bind — never fabricated. */
  get localAddress(): string | null {
    if (!this._listening) return null;
    return this.transport?.address()?.address ?? null;
  }

  /** Real local bound port, from the transport's own `address()`. See {@link localAddress}. */
  get localPort(): number | null {
    if (!this._listening) return null;
    return this.transport?.address()?.port ?? null;
  }

  /** Total datagrams successfully handed to the transport via `send()` since this engine was
   * created. */
  get packetsSent(): number {
    return this._packetsSent;
  }

  /** Total datagrams received from the gateway since this engine was created (decode failures
   * are tracked separately via {@link lastDecodeError} but DO still count as received — see the
   * UDP Receive Pipeline Audit doc for why reception and parsing are deliberately independent
   * facts). */
  get packetsReceived(): number {
    return this._packetsReceived;
  }

  /** Total datagrams that decoded successfully since this engine was created — the "Decoded"
   * counter for the Transport Monitor's Casambi Adapter section. Always `<= packetsReceived`. */
  get decodedCount(): number {
    return this._decodedCount;
  }

  /** Total datagrams that failed to decode since this engine was created — the "Decode Failures"
   * counter for the Transport Monitor's Casambi Adapter section. See {@link lastDecodeError} for
   * the most recent one's detail. */
  get decodeFailureCount(): number {
    return this._decodeFailureCount;
  }

  /** ISO timestamp of the most recently received packet, or `null` if none has arrived yet. */
  get lastPacketAt(): string | null {
    return this._lastPacketAt;
  }

  /** § LAN Transport Phase 2 — Transport Monitor. `null` before `start()`; see
   * {@link CasambiUdpTransportDiagnostics}. */
  get transportDiagnostics(): CasambiUdpTransportDiagnostics | null {
    const transport = this.transport;
    if (!transport) return null;
    const backend =
      transport instanceof NatsUdpTransportClient
        ? "nats"
        : transport instanceof LocalDirectUdpTransport
          ? "local-direct"
          : "unknown";
    const t = transport as unknown as { packetsSent?: unknown; packetsReceived?: unknown; lastError?: unknown };
    return {
      backend,
      packetsSent: typeof t.packetsSent === "number" ? t.packetsSent : null,
      packetsReceived: typeof t.packetsReceived === "number" ? t.packetsReceived : null,
      lastError: typeof t.lastError === "string" ? t.lastError : null,
    };
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
   * the disclosed, non-fabricated interpretation.
   */
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
    if (this.transport) return; // idempotent, matching every other transport's start()
    const transport = this.opts.udpTransportFactory();
    this.unsubMessage = transport.onMessage((msg, rinfo) => this.handleMessage(msg, rinfo));
    this.unsubError = transport.onError((err) => this.emitError(err));
    this.transport = transport;

    try {
      await transport.bind({ localPort: this.opts.localPort ?? this.opts.udpPort });
      this._listening = true;
      this._lastError = null;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this.unsubMessage?.();
      this.unsubError?.();
      this.transport = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this._listening = false;
    this.unsubMessage?.();
    this.unsubError?.();
    this.unsubMessage = null;
    this.unsubError = null;
    if (!transport) return;
    await transport.close();
  }

  onPacket(listener: (packet: CasambiUdpPacket) => void): () => void {
    this.packetListeners.add(listener);
    return () => this.packetListeners.delete(listener);
  }

  /**
   * Fires for EVERY datagram the transport delivers, immediately and before any parsing,
   * validation, or filtering (§ UDP Receive Pipeline Audit, Step 1). Use this to prove
   * transport-level reception is working independent of decode outcome — e.g. wiring it to the
   * driver's trace log gives an immediate "UDP datagram received" line for every packet, sent or
   * broadcast, that Wireshark also sees.
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

  /** Transport-level errors (bind failures, ICMP unreachable, etc). */
  onError(listener: (err: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** Malformed/undecodable incoming datagrams — kept distinct from `onError` since these are
   * per-packet parse failures, not a broken transport. */
  onDecodeError(listener: (raw: string, err: Error) => void): () => void {
    this.decodeErrorListeners.add(listener);
    return () => this.decodeErrorListeners.delete(listener);
  }

  /** Send a pre-built packet (its `netId`/`direction` are used verbatim — callers typically pass
   * one of `udp-codec.ts`'s `encodeXxx()` builders). */
  async send(packet: CasambiPacket): Promise<void> {
    if (!this.transport) throw new Error("casambi: UDP engine send() called before start()");
    const text = encodeCasambiPacket(packet, this.format);
    try {
      await this.transport.send(Buffer.from(text, "ascii"), this.opts.udpPort, this.opts.gatewayIp);
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
    if (!this.transport) throw new Error("casambi: UDP engine probe() called before start()");
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
    // § UDP Receive Pipeline Audit — counted and traced the instant the transport delivers a
    // datagram, strictly before parsing/validation/opcode decoding/filtering. Real hardware
    // evidence (Wireshark) showed the Lithernet gateway broadcasting NotifyControlValues to
    // 255.255.255.255:10009 rather than unicasting to this client — neither this engine nor
    // `@supreme/lan`'s transport filters by source or destination address, so a broadcast
    // datagram is received exactly like a unicast one. Counting/tracing here, ahead of decode,
    // means a real reception failure and a real parse failure are never indistinguishable again.
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
      this._decodedCount += 1;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      parseError = error.message;
      this._lastDecodeError = { raw, message: error.message, at };
      this._decodeFailureCount += 1;
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
