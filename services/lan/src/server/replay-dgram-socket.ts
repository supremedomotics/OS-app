import { defaultDgramSocket, type DgramSocketFactory, type DgramSocketLike } from "./dgram-udp-session.js";

/**
 * Packet Replay Framework (§ Casambi Local Gateway — Final Hardware Validation & Production
 * Gate). Protocol-agnostic and deliberately generic — lives in `@supreme/lan`, not
 * `@supreme/protocols`, because replaying a captured datagram is a transport-layer concern
 * exactly like sending/receiving a live one, reusable by any future LAN protocol the same way
 * `UdpTransport` itself is.
 *
 * `PacketCapture` is the ONE canonical, human-readable, protocol-agnostic capture format
 * (JSON: hex bytes + source rinfo + relative timing). It deliberately does NOT attempt real PCAP
 * binary import — parsing arbitrary third-party `.pcap`/`.pcapng` files correctly (link-layer
 * types, snaplen, byte order, multiple capture formats) is a large, open-ended format-compat
 * surface that does not change whether the actual goal — replaying a payload through the real
 * receive pipeline — is achieved. `exportPcap()` below is one-way (JSON capture -> a real `.pcap`
 * file openable in Wireshark), which is the side of the format that's actually useful here and is
 * a small, self-contained amount of code with zero new dependencies.
 */
export interface CapturedDatagram {
  /** Raw datagram bytes, hex-encoded — the one canonical wire representation. ASCII is always
   * derivable from this (`capturedDatagramAscii`), never stored redundantly/inconsistently. */
  rawHex: string;
  sourceAddress: string;
  sourcePort: number;
  /** Milliseconds since the FIRST packet in the same capture — replay pacing uses this so a
   * multi-packet capture (e.g. a real commissioning burst) replays with realistic timing, not
   * all at once. `0` for a capture's first (or only) packet. */
  relativeTimeMs: number;
}

export interface PacketCapture {
  name: string;
  savedAt: string;
  description?: string;
  /** § Real Hardware Certification — a free-form, protocol-agnostic bag (firmware version,
   * gateway/device version, wire format, network id, capture date, free-text notes, …). Kept as
   * an untyped `Record` here since `@supreme/lan` has no business knowing what "Net ID" or "Data
   * Format" mean — protocol-specific consumers (e.g. `@supreme/protocols`'s Casambi captures)
   * define and read their own well-typed metadata shape on top of this bag; see
   * `CasambiCaptureMetadata` in `services/protocols/src/casambi/`. */
  metadata?: Record<string, unknown>;
  packets: CapturedDatagram[];
}

export function capturedDatagramAscii(d: CapturedDatagram): string {
  return Buffer.from(d.rawHex, "hex").toString("ascii");
}

export function capturedDatagramBuffer(d: CapturedDatagram): Buffer {
  return Buffer.from(d.rawHex, "hex");
}

/** Build a `PacketCapture` from raw datagrams (e.g. straight off a real, Wireshark-confirmed
 * wire capture) — the one place `Buffer`s get hex-encoded for storage. */
export function makeCapture(
  name: string,
  packets: { raw: Buffer; rinfo: { address: string; port: number }; atMs?: number }[],
  description?: string,
  metadata?: Record<string, unknown>,
): PacketCapture {
  const first = packets[0]?.atMs ?? 0;
  return {
    name,
    savedAt: new Date().toISOString(),
    description,
    metadata,
    packets: packets.map((p) => ({
      rawHex: p.raw.toString("hex"),
      sourceAddress: p.rinfo.address,
      sourcePort: p.rinfo.port,
      relativeTimeMs: (p.atMs ?? first) - first,
    })),
  };
}

export interface ReplayHandle {
  /** Stops an in-progress `loop: true` or multi-packet timed replay. A no-op once finished. */
  stop(): void;
}

/**
 * A `DgramSocketLike` that behaves EXACTLY like a real one for bind/send/close/address (backed by
 * `base`, real `node:dgram` by default) and additionally exposes `injectDatagram`/`replay` to
 * synthetically fire the identical "message" event a real received datagram would. This is the
 * mechanism that satisfies "no code path may differ": `DgramUdpSession` registers exactly one
 * `"message"` listener (the same it always has), and injection calls that SAME listener directly
 * — everything from `DgramUdpSession` upward (`UdpTransportServer`, NATS, `NatsUdpTransportClient`,
 * the protocol adapter, the driver) runs unmodified, unaware whether a datagram came from a real
 * socket event or a replay call.
 *
 * Pass a fake `base` (e.g. a pure in-memory stub) for hermetic CI regression replay with no real
 * sockets/ports involved; the default real `base` is for live developer-mode replay against a
 * genuinely running `supreme-lan` process (see `docs/architecture/Casambi-Packet-Replay-Guide.md`).
 */
/** § Real Hardware Certification — "Live Capture." Returned by `startRecording()`; `count`
 * updates in real time as real datagrams arrive, `finish()` stops recording and returns
 * everything captured as a ready-to-save `PacketCapture`. This is how a real, physical Lithernet
 * gateway's actual traffic becomes a permanent capture file — no code path differs from normal
 * reception; recording is a pure side-observation, never a change to what `DgramUdpSession`
 * (and everything above it) sees or does with the same datagram. */
export interface LiveCaptureHandle {
  readonly count: number;
  finish(name: string, description?: string, metadata?: Record<string, unknown>): PacketCapture;
}

export function replayableDgramSocket(base: DgramSocketFactory = defaultDgramSocket): DgramSocketLike & {
  injectDatagram(datagram: CapturedDatagram): void;
  replay(capture: PacketCapture, opts?: { loop?: boolean; speedMultiplier?: number }): ReplayHandle;
  startRecording(): LiveCaptureHandle;
} {
  const real = base();
  const messageListeners = new Set<(msg: Buffer, rinfo: { address: string; port: number }) => void>();
  let activeRecording: { packets: CapturedDatagram[]; startedAt: number } | null = null;

  // Registered ONCE, directly on the real socket, regardless of how many `DgramUdpSession`s ever
  // call `wrapped.on("message", ...)` — real reception and recording are independent concerns,
  // neither one gated on the other being active.
  real.on("message", (msg, rinfo) => {
    for (const l of messageListeners) l(msg, rinfo);
    if (activeRecording) {
      const rec = activeRecording;
      rec.packets.push({
        rawHex: msg.toString("hex"),
        sourceAddress: rinfo.address,
        sourcePort: rinfo.port,
        relativeTimeMs: Date.now() - rec.startedAt,
      });
    }
  });

  const wrapped: DgramSocketLike = {
    bind: (port, address) => real.bind(port, address),
    send: (msg, port, address, cb) => real.send(msg, port, address, cb),
    close: (cb) => real.close(cb),
    address: () => real.address(),
    setBroadcast: (flag) => real.setBroadcast(flag),
    addMembership: (group, iface) => real.addMembership(group, iface),
    setMulticastInterface: (iface) => real.setMulticastInterface?.(iface),
    on: ((event: "message" | "error" | "listening", listener: (...args: unknown[]) => void) => {
      if (event === "message") {
        messageListeners.add(listener as (msg: Buffer, rinfo: { address: string; port: number }) => void);
        return undefined;
      }
      return real.on(event as "error", listener as (err: Error) => void);
    }) as DgramSocketLike["on"],
  };

  function startRecording(): LiveCaptureHandle {
    const rec = { packets: [] as CapturedDatagram[], startedAt: Date.now() };
    activeRecording = rec;
    return {
      get count() {
        return rec.packets.length;
      },
      finish: (name, description, metadata) => {
        if (activeRecording === rec) activeRecording = null;
        return { name, savedAt: new Date().toISOString(), description, metadata, packets: rec.packets };
      },
    };
  }

  function injectDatagram(datagram: CapturedDatagram): void {
    const msg = capturedDatagramBuffer(datagram);
    const rinfo = { address: datagram.sourceAddress, port: datagram.sourcePort };
    for (const l of messageListeners) l(msg, rinfo);
  }

  function replay(capture: PacketCapture, opts: { loop?: boolean; speedMultiplier?: number } = {}): ReplayHandle {
    const speed = opts.speedMultiplier ?? 1;
    let stopped = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    function runOnce(onDone: () => void): void {
      if (capture.packets.length === 0) {
        onDone();
        return;
      }
      let remaining = capture.packets.length;
      for (const packet of capture.packets) {
        const delay = Math.max(0, packet.relativeTimeMs / speed);
        const t = setTimeout(() => {
          if (stopped) return;
          injectDatagram(packet);
          remaining -= 1;
          if (remaining === 0) onDone();
        }, delay);
        timers.push(t);
      }
    }

    function loopRun(): void {
      if (stopped) return;
      runOnce(() => {
        if (opts.loop && !stopped) loopRun();
      });
    }
    loopRun();

    return {
      stop: () => {
        stopped = true;
        for (const t of timers) clearTimeout(t);
        timers.length = 0;
      },
    };
  }

  return Object.assign(wrapped, { injectDatagram, replay, startRecording });
}

/** A pure in-memory `DgramSocketLike` base (no real socket) — the hermetic replay base for CI
 * regression tests. `bind`/`send`/`close` all resolve immediately with no real I/O; formalizes the
 * fake-socket pattern this codebase's test files were each hand-rolling separately. Also exposes
 * `emitMessage`/`emitError` (beyond the `DgramSocketLike` interface, purely test-support) so a
 * test can simulate a REAL datagram arriving at the base layer — distinct from
 * `replayableDgramSocket`'s own `injectDatagram`, which fires listeners directly and is never
 * observed by `startRecording()` (recording only sees traffic through this real base). */
export function fakeDgramSocket(): DgramSocketLike & {
  emitMessage(msg: Buffer, rinfo: { address: string; port: number }): void;
  emitError(err: Error): void;
} {
  let bound = { address: "0.0.0.0", port: 0, family: "IPv4" };
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    bind: (port, address) => {
      bound = { address: address ?? "0.0.0.0", port: port ?? 0, family: "IPv4" };
      queueMicrotask(() => {
        for (const l of listeners.get("listening") ?? []) l();
      });
    },
    send: (_msg, _port, _address, cb) => cb?.(null),
    close: (cb) => cb?.(),
    address: () => bound,
    setBroadcast: () => {},
    addMembership: () => {},
    setMulticastInterface: () => {},
    on: ((event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return undefined;
    }) as DgramSocketLike["on"],
    emitMessage: (msg, rinfo) => {
      for (const l of listeners.get("message") ?? []) l(msg, rinfo);
    },
    emitError: (err) => {
      for (const l of listeners.get("error") ?? []) l(err);
    },
  };
}
