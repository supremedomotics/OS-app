/**
 * AVR Diagnostic Mode (§ AVR Diagnostic Mode) — an installer-enabled, production-safe
 * tracing facility for the Denon/Marantz Telnet driver (`avr-driver.ts`). Captures the
 * complete lifecycle of every real receiver event — TCP receive → parse →
 * capability-state patch → dedupe/dispatch decision → gateway publish → WebSocket send
 * — under one correlation ID per event, plus session-wide counters and an
 * unknown-command frequency table. Built specifically so a real installation's own
 * receiver traffic can be captured and handed back for analysis without this codebase
 * ever needing (or pretending to have) direct hardware access — see
 * `docs/architecture/AVR-Diagnostic-Mode.md`.
 *
 * Off by default. Every call site in `avr-driver.ts` goes through `this.diagnostics?.
 * method(...)` — when disabled, `this.diagnostics` is `null` and optional chaining
 * short-circuits BEFORE any argument expression is evaluated (real, spec-guaranteed
 * JS/TS behavior: `a?.b(expensive())` never calls `expensive()` when `a` is nullish),
 * so the disabled cost is one property read + one null check per call site — no string
 * building, no allocation, no I/O. This is the same "opt-in, effectively free when off"
 * shape `trace`/`ProtocolTracer` already uses elsewhere in this driver; this module is
 * deliberately a separate, more structured facility rather than folded into
 * `ProtocolTracer`, because the two answer different questions: `ProtocolTracer` is
 * "what raw bytes went over the wire" (already shipped, always available), this module
 * is "what happened to ONE event as it moved through the whole pipeline, end to end,
 * including hops outside this driver" (gateway publish, WebSocket send) — a genuinely
 * different, heavier, opt-in-only capability.
 */

/** One session's running counters — every number here is exact, never estimated. */
export interface AvrDiagnosticsCounters {
  commandsReceived: number;
  commandsParsed: number;
  unknownCommands: number;
  eventsDispatched: number;
  /** `bindingsMissing + cacheDeduplicated` — every parsed update that did NOT result in
   * a dispatch to listeners, for either reason. Kept as its own counter (not derived at
   * report time) so the two counters it's built from can never silently drift from it. */
  eventsDropped: number;
  bindingsMissing: number;
  cacheDeduplicated: number;
  gatewayPublishes: number;
  websocketSends: number;
}

interface UnknownCommandRecord {
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  host: string;
  port: number;
  hex: string;
  ascii: string;
  length: number;
  firstToken: string;
}

const DEFAULT_MAX_BUFFERED_LINES = 100_000;
/** Defensive cap on distinct unknown-command patterns tracked — a malfunctioning or
 * non-conforming device spamming unique garbage should degrade gracefully (oldest-count
 * pattern evicted), never grow this table without bound. Real installations should never
 * come close to this; it exists purely as a safety ceiling. */
const MAX_UNKNOWN_PATTERNS = 2_000;

/** Renders a string as `ASCII` with every non-printable byte shown as `.` — safe to put
 * in a log line unconditionally, never breaks formatting or leaks control characters. */
function safeAscii(line: string): string {
  return line.replace(/[^\x20-\x7e]/g, ".");
}

export class AvrDiagnosticsRecorder {
  private seq = 0;
  private readonly startedAt = new Date().toISOString();
  private readonly lines: string[] = [];
  private readonly maxBufferedLines: number;
  private droppedLineCount = 0;
  private readonly onLog?: (level: "info" | "warn" | "error", message: string) => void;
  private readonly counters: AvrDiagnosticsCounters = {
    commandsReceived: 0,
    commandsParsed: 0,
    unknownCommands: 0,
    eventsDispatched: 0,
    eventsDropped: 0,
    bindingsMissing: 0,
    cacheDeduplicated: 0,
    gatewayPublishes: 0,
    websocketSends: 0,
  };
  private readonly unknownCommands = new Map<string, UnknownCommandRecord>();

  constructor(opts: { onLog?: (level: "info" | "warn" | "error", message: string) => void; maxBufferedLines?: number } = {}) {
    this.onLog = opts.onLog;
    this.maxBufferedLines = opts.maxBufferedLines ?? DEFAULT_MAX_BUFFERED_LINES;
    this.emitRaw(`AVR Diagnostic Mode enabled at ${this.startedAt}`);
  }

  /** One correlation ID per real receiver EVENT (one Telnet line = one event) —
   * `AVR-000001`, `AVR-000002`, … zero-padded to 6 digits, matching the requested
   * format exactly. Monotonic for the lifetime of this recorder (a driver instance
   * lives for the hub process's lifetime, or until diagnostics is toggled off/on). */
  nextId(): string {
    this.seq += 1;
    return `AVR-${String(this.seq).padStart(6, "0")}`;
  }

  /** `[TCP]` stage — the raw line as received, before any parsing. */
  recordReceived(id: string, host: string, port: number, line: string): void {
    this.counters.commandsReceived += 1;
    this.emit(id, "TCP", { host, port, line: JSON.stringify(line) });
  }

  /** `[Parser]` stage — the structured update `parseAvrLine()` produced, or `null`. */
  recordParsed(id: string, update: unknown): void {
    if (update !== null) this.counters.commandsParsed += 1;
    this.emit(id, "Parser", { update: JSON.stringify(update) });
  }

  /** § "Unknown protocol" requirement — a line `parseAvrLine()` didn't recognize gets a
   * real forensic capture (hex/ASCII/length/first token/sender/running frequency), never
   * a bare "unrecognized line" message. Keyed by the exact raw line text, so genuinely
   * distinct unknown commands are tracked separately and the session report can show
   * "X observed N times" per distinct pattern, most-frequent first. */
  recordUnknown(id: string, host: string, port: number, line: string): void {
    this.counters.unknownCommands += 1;
    const now = new Date().toISOString();
    const buf = Buffer.from(line, "utf8");
    const hex = buf.toString("hex");
    const ascii = safeAscii(line);
    const length = buf.length;
    const firstToken = line.trim().split(/\s+/)[0] ?? line;
    let record = this.unknownCommands.get(line);
    if (record) {
      record.count += 1;
      record.lastSeenAt = now;
    } else {
      if (this.unknownCommands.size >= MAX_UNKNOWN_PATTERNS) {
        // Evict the least-frequently-observed pattern to make room — a defensive
        // ceiling, not something a real installation should ever actually hit.
        let evictKey: string | null = null;
        let evictCount = Infinity;
        for (const [k, v] of this.unknownCommands) {
          if (v.count < evictCount) { evictCount = v.count; evictKey = k; }
        }
        if (evictKey !== null) this.unknownCommands.delete(evictKey);
      }
      record = { count: 1, firstSeenAt: now, lastSeenAt: now, host, port, hex, ascii, length, firstToken };
      this.unknownCommands.set(line, record);
    }
    this.emit(id, "Unknown", {
      host, port, hex, ascii, length, firstToken,
      occurrences: record.count,
      note: `observed ${record.count} time${record.count === 1 ? "" : "s"} this session`,
    });
  }

  /** `[patchMedia]`/`[emitFor]` stage — the binding lookup result and, when a binding
   * was found, the capability-state cache's before/after values. `deviceId: null` and
   * `oldState`/`newState: undefined` when no binding was found (nothing to show). */
  recordPatch(
    id: string,
    stageName: "patchMedia" | "emitFor",
    params: {
      host: string;
      port: number;
      zone: string;
      capability: string;
      deviceId: string | null;
      bindingFound: boolean;
      oldState?: unknown;
      newState?: unknown;
    },
  ): void {
    if (!params.bindingFound) this.counters.bindingsMissing += 1;
    this.emit(id, stageName, {
      host: params.host,
      port: params.port,
      zone: params.zone,
      capability: params.capability,
      deviceId: params.deviceId ?? "NONE",
      bindingFound: params.bindingFound,
      ...(params.bindingFound ? { old: JSON.stringify(params.oldState), new: JSON.stringify(params.newState) } : {}),
    });
  }

  /** `[StateCache]` stage — the dedupe comparison result and listener fan-out count.
   * `deviceId`/`old`/`new` mirror exactly what `recordCapabilityState()` (the real,
   * unmodified shared function) is about to compute — read-only, computed alongside it
   * for diagnostics purposes, never altering its actual dedupe decision. */
  recordStateCache(
    id: string,
    params: { deviceId: string; capability: string; changed: boolean; listenerCount: number; oldState: unknown; newState: unknown },
  ): void {
    if (params.changed) this.counters.eventsDispatched += 1;
    else {
      this.counters.cacheDeduplicated += 1;
      this.counters.eventsDropped += 1;
    }
    this.emit(id, "StateCache", {
      deviceId: params.deviceId,
      capability: params.capability,
      old: JSON.stringify(params.oldState),
      new: JSON.stringify(params.newState),
      changed: params.changed,
      listeners: params.listenerCount,
      dispatch: params.changed,
    });
  }

  /** A parsed update whose target binding didn't exist counts as a dropped event too —
   * called once per `recordPatch(..., { bindingFound: false })`, kept as a distinct
   * method so the "why was this dropped" reason is explicit at the call site rather than
   * inferred from `recordPatch`'s own bookkeeping. */
  recordDropped(id: string, reason: string): void {
    this.counters.eventsDropped += 1;
    this.emit(id, "Dropped", { reason });
  }

  /** Generic stage recorder — used both internally and by `recordDiagnosticStage()`
   * (the `INativeProtocolDriver` optional method gateway-layer code calls into) for the
   * `[Gateway]`/`[WebSocket]` stages, which happen outside this driver entirely. */
  recordDiagnosticStage(id: string, stage: string, fields: Record<string, unknown>): void {
    if (stage === "Gateway" && fields.published === true) this.counters.gatewayPublishes += 1;
    if (stage === "WebSocket" && fields.sent === true) this.counters.websocketSends += 1;
    this.emit(id, stage, fields);
  }

  private emit(id: string, stage: string, fields: Record<string, unknown>): void {
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    this.emitRaw(`${new Date().toISOString()} [${id}][${stage}] ${parts.join(" ")}`);
  }

  private emitRaw(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.maxBufferedLines) {
      this.lines.shift();
      this.droppedLineCount += 1;
    }
    this.onLog?.("info", `[avr-diagnostics] ${line}`);
  }

  /** Snapshot of the exact counters so far — real numbers, not derived at export time
   * from the line buffer (which may have evicted old entries; the counters never do). */
  snapshot(): AvrDiagnosticsCounters {
    return { ...this.counters };
  }

  /** § "Session Report" requirement — produced on demand (callers call this at
   * `disconnect()`/shutdown, or any time via the export route). Every counter is exact
   * for the full session regardless of whether individual raw lines were evicted from
   * the bounded buffer above. */
  sessionReport(): string {
    const c = this.counters;
    const uptime = Date.now() - new Date(this.startedAt).getTime();
    const unknownSorted = [...this.unknownCommands.entries()].sort((a, b) => b[1].count - a[1].count);
    const lines = [
      "===== AVR Diagnostic Mode — Session Report =====",
      `Started:            ${this.startedAt}`,
      `Report generated:   ${new Date().toISOString()}`,
      `Session duration:   ${Math.round(uptime / 1000)}s`,
      "",
      "Counters:",
      `  commands received:    ${c.commandsReceived}`,
      `  commands parsed:       ${c.commandsParsed}`,
      `  unknown commands:      ${c.unknownCommands} (${unknownSorted.length} distinct pattern${unknownSorted.length === 1 ? "" : "s"})`,
      `  events dispatched:     ${c.eventsDispatched}`,
      `  events dropped:        ${c.eventsDropped}  (= bindings missing + cache deduplicated)`,
      `    bindings missing:      ${c.bindingsMissing}`,
      `    cache deduplicated:    ${c.cacheDeduplicated}`,
      `  gateway publishes:     ${c.gatewayPublishes}`,
      `  websocket sends:       ${c.websocketSends}`,
      "",
    ];
    if (unknownSorted.length > 0) {
      lines.push("Unknown commands (most frequent first):");
      for (const [line, r] of unknownSorted) {
        lines.push(
          `  "${safeAscii(line)}" observed ${r.count} time${r.count === 1 ? "" : "s"} — first seen ${r.firstSeenAt}, last seen ${r.lastSeenAt}, sender=${r.host}:${r.port}, firstToken=${r.firstToken}, length=${r.length} bytes, hex=${r.hex}`,
        );
      }
      lines.push("");
    }
    if (this.droppedLineCount > 0) {
      lines.push(
        `Note: the raw trace buffer is capped at ${this.maxBufferedLines} lines; ${this.droppedLineCount} of the oldest lines were evicted to stay within that bound. The counters and unknown-command table above are exact for the FULL session regardless — only the raw line-by-line trace below is truncated to the most recent ${this.maxBufferedLines} lines.`,
      );
      lines.push("");
    }
    lines.push("=================================================");
    return lines.join("\n");
  }

  /** § "Export" requirement — the complete buffered trace, followed by the session
   * report, as one string ready to write straight to `diagnostic.log`. */
  exportLog(): string {
    return [
      `# SupremeOS AVR Diagnostic Mode — exported ${new Date().toISOString()}`,
      "",
      "## Raw trace (chronological)",
      "",
      ...this.lines,
      "",
      "## Session summary",
      "",
      this.sessionReport(),
      "",
    ].join("\n");
  }
}
