/**
 * SupremeOS Universal AV SDK — raw protocol tracer (§ Production Bugfix Sprint, item
 * "Capture and log the raw protocol responses for every discovery, capability, command,
 * and event operation during debugging").
 *
 * The existing `onLog` callback (already wired into AVR/HEOS's Extension Center driver
 * log) only ever fired for connection lifecycle events (connect/error) — the actual wire
 * traffic was tracked ONLY as `DriverDiagnosticsTracker`'s single most-recent
 * lastCommand/lastResponse, with no full history. Real hardware debugging needs the
 * FULL sequence — every token sent, every line received, every discovery/capability
 * query — not just the last one. This reuses the SAME `onLog` pipeline (no new logging
 * subsystem) rather than inventing a second, parallel logging channel, gated behind an
 * explicit `trace` flag so normal operation isn't flooded with per-token log lines —
 * default is off, matching every other opt-in diagnostic in this codebase.
 */

export type LogFn = (level: "info" | "warn" | "error", message: string) => void;

export interface ProtocolTracer {
  /** A command/request token was written to the wire. */
  send(line: string): void;
  /** A response/status line was read off the wire. */
  receive(line: string): void;
  /** A non-line-shaped protocol operation (discovery search, capability-config read,
   * UDP event, HTTP request/response, …) worth recording in sequence. */
  event(description: string): void;
}

const NOOP_TRACER: ProtocolTracer = { send() {}, receive() {}, event() {} };

/** `enabled: false` (the default) returns a zero-cost no-op tracer — every call site can
 * unconditionally call `tracer.send(...)` without its own `if (trace)` guard. */
export function createProtocolTracer(protocol: string, enabled: boolean, onLog?: LogFn): ProtocolTracer {
  if (!enabled || !onLog) return NOOP_TRACER;
  return {
    send: (line) => onLog("info", `[trace:${protocol}] -> ${line}`),
    receive: (line) => onLog("info", `[trace:${protocol}] <- ${line}`),
    event: (description) => onLog("info", `[trace:${protocol}] ${description}`),
  };
}
