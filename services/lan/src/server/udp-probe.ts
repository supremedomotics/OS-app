import dgram from "node:dgram";
import type { DgramSocketFactory, DgramSocketLike } from "./dgram-udp-session.js";

/**
 * § Runtime Data Path Verification — the independent UDP listener.
 *
 * Deliberately the dumbest possible receiver in this codebase: it binds a port and writes down
 * every datagram the kernel hands it. **No decoder, no NATS republish, no protocol, no Casambi.**
 * That isolation is the entire point — it splits one unanswerable question ("why does SupremeOS
 * see zero packets?") into two answerable ones:
 *
 *   - probe receives nothing while a host capture shows traffic → the loss is BELOW SupremeOS
 *     (kernel/namespace/interface/firewall). No application change can fix it.
 *   - probe receives datagrams while the Casambi driver still reports zero → the loss is INSIDE
 *     SupremeOS, somewhere between the socket and the driver, and the pipeline stages localize it.
 *
 * There is no third outcome, which is what makes this worth its own module rather than another
 * counter on an existing one. Nothing here is shared with the Casambi receive path, so a bug in
 * that path cannot make this probe lie in either direction.
 *
 * It binds its OWN socket on the same port rather than tapping the driver's. `reuseAddr` (already
 * set by `defaultDgramSocket`) lets both coexist; on Linux both sockets receive broadcast and
 * multicast datagrams delivered to that port. Unicast to a port with two `SO_REUSEADDR` listeners
 * is delivered to only ONE of them, so a unicast-only gateway may show up in exactly one place —
 * called out here because it is a real interpretation trap, and reported in the snapshot's own
 * `caveat` field rather than left for someone to rediscover.
 */

/** One datagram, exactly as received. Nothing is parsed, so nothing can be misparsed. */
export interface ProbeDatagram {
  at: string;
  /** Milliseconds since the probe started listening — a monotonic-ish relative view that survives
   * wall-clock adjustment, useful for spotting a burst vs. a steady broadcast interval. */
  sinceListeningMs: number;
  sourceAddress: string;
  sourcePort: number;
  /** Byte length as the kernel delivered it, independent of any encoding below. */
  length: number;
  hex: string;
  /** Printable-ASCII rendering; non-printable bytes become `.` so the field is always safe to log
   * and display. Never used as evidence of a payload's meaning — `hex` is the authority. */
  ascii: string;
}

export interface UdpProbeSnapshot {
  configuredPort: number;
  listening: boolean;
  boundAddress: string | null;
  boundPort: number | null;
  startedAt: string | null;
  /** Real count of datagrams delivered to THIS socket. Zero here, with traffic visible in a host
   * capture, is the decisive "below SupremeOS" evidence. */
  datagramsReceived: number;
  firstDatagramAt: string | null;
  lastDatagramAt: string | null;
  /** Bind/runtime error, or `null`. `EADDRINUSE` here means the port is held by a socket that did
   * NOT set SO_REUSEADDR — itself a real finding, not a probe defect. */
  lastError: string | null;
  /** Bounded, most-recent-last. Capped so a chatty LAN cannot grow this without limit. */
  recent: readonly ProbeDatagram[];
  /** Interpretation traps that apply to THIS snapshot, stated up front so the number above is not
   * over-read. Always present, never empty — there is always at least the unicast caveat. */
  caveats: string[];
}

const MAX_RETAINED = 50;

export interface UdpProbeOptions {
  port: number;
  /** Bind address. Defaults to all interfaces, matching every other socket in this service. */
  address?: string;
  /** Enables receiving broadcast on platforms that require the flag for it. Harmless where it is
   * not required, so it defaults on: a probe that silently misses broadcast would defeat its
   * entire purpose. */
  broadcast?: boolean;
  /** Optional multicast group to join, for probing a multicast protocol (KNX, mDNS, SSDP) rather
   * than a broadcast one. */
  multicastGroup?: string;
  multicastInterface?: string;
}

export class UdpProbe {
  private socket: DgramSocketLike | null = null;
  private _listening = false;
  private _boundAddress: string | null = null;
  private _boundPort: number | null = null;
  private _startedAt: string | null = null;
  private _startedAtMs = 0;
  private _received = 0;
  private _firstAt: string | null = null;
  private _lastAt: string | null = null;
  private _lastError: string | null = null;
  private readonly log: ProbeDatagram[] = [];

  constructor(
    private readonly opts: UdpProbeOptions,
    private readonly socketFactory: DgramSocketFactory = () => defaultProbeSocket(),
  ) {}

  async start(): Promise<void> {
    const socket = this.socketFactory();
    socket.on("message", (msg, rinfo) => this.record(msg, rinfo));
    socket.on("error", (err) => {
      this._lastError = err.message;
    });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        this._lastError = err.message;
        reject(err);
      });
      socket.on("listening", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      socket.bind(this.opts.port, this.opts.address);
    });

    if (this.opts.broadcast !== false) socket.setBroadcast(true);
    if (this.opts.multicastGroup) {
      if (this.opts.multicastInterface) socket.setMulticastInterface?.(this.opts.multicastInterface);
      socket.addMembership(this.opts.multicastGroup, this.opts.multicastInterface);
    }

    const addr = socket.address();
    this._boundAddress = addr.address;
    this._boundPort = addr.port;
    this._listening = true;
    this._startedAtMs = Date.now();
    this._startedAt = new Date(this._startedAtMs).toISOString();
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this._listening = false;
    if (!socket) return;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  private record(msg: Buffer, rinfo: { address: string; port: number }): void {
    const now = Date.now();
    const at = new Date(now).toISOString();
    this._received += 1;
    this._firstAt ??= at;
    this._lastAt = at;
    this.log.push({
      at,
      sinceListeningMs: this._startedAtMs === 0 ? 0 : now - this._startedAtMs,
      sourceAddress: rinfo.address,
      sourcePort: rinfo.port,
      length: msg.length,
      hex: msg.toString("hex"),
      ascii: toPrintableAscii(msg),
    });
    if (this.log.length > MAX_RETAINED) this.log.shift();
  }

  snapshot(): UdpProbeSnapshot {
    return {
      configuredPort: this.opts.port,
      listening: this._listening,
      boundAddress: this._boundAddress,
      boundPort: this._boundPort,
      startedAt: this._startedAt,
      datagramsReceived: this._received,
      firstDatagramAt: this._firstAt,
      lastDatagramAt: this._lastAt,
      lastError: this._lastError,
      recent: [...this.log],
      caveats: this.caveats(),
    };
  }

  private caveats(): string[] {
    const caveats = [
      "This probe binds its own SO_REUSEADDR socket on the same port as the driver. Broadcast and multicast datagrams are delivered to BOTH sockets, but a UNICAST datagram is delivered to only one of them — so a unicast-only gateway can legitimately appear here and not in the driver, or vice versa.",
    ];
    if (!this._listening) {
      caveats.push("The probe is not listening, so `datagramsReceived = 0` says nothing about whether traffic is arriving. Fix the bind error before drawing any conclusion.");
    } else if (this._received === 0) {
      caveats.push(
        "Zero datagrams on a socket that IS bound and listening is real evidence only when paired with a host-side capture (tcpdump/Wireshark) taken over the SAME window that shows the traffic actually arriving at the machine. Without that pairing, 'the gateway was not transmitting' remains equally consistent with this result.",
      );
    }
    return caveats;
  }
}

/** Renders bytes as printable ASCII with `.` for anything non-printable — display only. */
function toPrintableAscii(msg: Buffer): string {
  let out = "";
  for (const byte of msg) out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
  return out;
}

/** A real probe socket. Separate from `defaultDgramSocket` only so the probe's own requirements
 * (always `reuseAddr`, so it can coexist with the driver's socket on the same port) are explicit
 * rather than inherited by coincidence. */
export function defaultProbeSocket(): DgramSocketLike {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  return {
    bind: (port, address) => sock.bind(port, address),
    send: (msg, port, address, cb) => sock.send(msg, port, address, cb),
    close: (cb) => sock.close(cb),
    address: () => sock.address(),
    setBroadcast: (flag) => sock.setBroadcast(flag),
    addMembership: (group, iface) => sock.addMembership(group, iface),
    setMulticastInterface: (iface) => sock.setMulticastInterface(iface),
    getRecvBufferSize: () => sock.getRecvBufferSize(),
    getSendBufferSize: () => sock.getSendBufferSize(),
    on: (event, listener) => sock.on(event, listener),
  };
}
