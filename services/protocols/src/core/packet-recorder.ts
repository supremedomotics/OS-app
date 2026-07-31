/**
 * SupremeOS Packet Recorder Framework (§ Casambi Driver Refactor — PR-2). Architecture only, per
 * the brief: a reusable capture/store/query surface every future protocol driver (REST, UDP, TCP,
 * MQTT, KNX, Matter, Lutron, RTI, DALI, Bluetooth, …) can feed real entries into — this module
 * itself never parses a protocol. The one real parser that exists today (Casambi's UDP codec,
 * `local-transport/udp-codec.ts`) already produces `decoded`/`raw` values in the exact shape this
 * recorder stores; nothing protocol-specific lives here.
 */

export type PacketDirection = "incoming" | "outgoing";

export interface RecordedPacket {
  id: number;
  direction: PacketDirection;
  ts: string;
  /** ms since this packet's request was sent, for a response; `null` for a one-way packet or one
   * whose matching request/response isn't tracked. */
  latencyMs: number | null;
  driver: string;
  deviceId?: string;
  /** Byte length of `raw`, independent of `raw`'s own string/hex encoding. */
  packetLength: number;
  /** Driver-decoded, human-inspectable representation (e.g. `{ opcode: 0x1E, scene: 1, level: 255 }`). */
  decoded: Record<string, unknown> | null;
  /** The literal wire bytes, hex-encoded. Never logged/exported with secrets — callers are
   * responsible for redacting credential-bearing protocols before recording. */
  raw: string;
}

export interface PacketRecorderFilter {
  driver?: string;
  deviceId?: string;
  direction?: PacketDirection;
  /** Case-insensitive substring match against `decoded`'s JSON representation. */
  search?: string;
  since?: string;
}

export interface PacketRecorderOptions {
  /** Maximum packets retained; oldest evicted first. Default 1000. */
  capacity?: number;
}

/** A bounded, in-memory ring buffer of recorded packets with filter/search/export. No
 * persistence (same tradeoff every other in-memory diagnostics ring buffer in this codebase
 * already makes — a hub restart clears it). */
export class PacketRecorder {
  private readonly capacity: number;
  private readonly buffer: RecordedPacket[] = [];
  private nextId = 1;

  constructor(opts: PacketRecorderOptions = {}) {
    this.capacity = opts.capacity ?? 1000;
  }

  record(entry: Omit<RecordedPacket, "id">): RecordedPacket {
    const packet: RecordedPacket = { ...entry, id: this.nextId++ };
    this.buffer.push(packet);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    return packet;
  }

  /** Convenience: record with `latencyMs` computed from a request timestamp already known to the
   * caller (e.g. a query's send time), never guessed here. */
  recordWithLatency(entry: Omit<RecordedPacket, "id" | "latencyMs">, requestSentAtMs: number | null): RecordedPacket {
    const latencyMs = requestSentAtMs === null ? null : Date.now() - requestSentAtMs;
    return this.record({ ...entry, latencyMs });
  }

  query(filter: PacketRecorderFilter = {}): RecordedPacket[] {
    return this.buffer.filter((p) => {
      if (filter.driver && p.driver !== filter.driver) return false;
      if (filter.deviceId && p.deviceId !== filter.deviceId) return false;
      if (filter.direction && p.direction !== filter.direction) return false;
      if (filter.since && p.ts < filter.since) return false;
      if (filter.search) {
        const haystack = JSON.stringify(p.decoded ?? {}).toLowerCase();
        if (!haystack.includes(filter.search.toLowerCase())) return false;
      }
      return true;
    });
  }

  /** All currently-retained packets, oldest first. */
  all(): readonly RecordedPacket[] {
    return this.buffer;
  }

  clear(): void {
    this.buffer.length = 0;
  }

  /** Newline-delimited JSON export, matching every other "Save Diagnostic Data"-style download
   * already used across this codebase's driver diagnostics pages. */
  export(filter?: PacketRecorderFilter): string {
    return this.query(filter).map((p) => JSON.stringify(p)).join("\n");
  }
}
