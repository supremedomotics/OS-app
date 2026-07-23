/**
 * Shared driver-diagnostics tracker (§ Diagnostics Console, Universal AV Driver SDK) —
 * real, incrementing-only counters and last-seen state for any driver that owns a
 * persistent link or issues request/response calls, so the Installer Diagnostics page
 * can show Connection Status, Last Command/Response, RX/TX packet counts, Reconnect
 * Count, and Response Time without every driver reimplementing this bookkeeping.
 * Mirrors the pattern already proven in `knx-ultimate-provider.ts`
 * (packetsSent/packetsReceived/lastCommandAt/reconnectAttempts), generalized so
 * AVR/HEOS/Yamaha — and any future AV driver — share one implementation instead of
 * three near-identical copies.
 *
 * Ownership split: a driver decides WHAT counts as a "command"/"response" for its own
 * wire protocol (a Telnet token pair, an HTTP request/response, a UDP event datagram)
 * and calls `recordSend`/`recordReceive` at the right point; this tracker only owns the
 * counters, timestamps, and response-time arithmetic — never protocol framing. Every
 * field is either a real counter or `null` when genuinely unknown (e.g. no protocol
 * here exposes firmware on the wire) — never a fabricated placeholder.
 */

import type { DriverConnectionStatus, DriverDiagnosticsSnapshot, DriverTraceEntry } from "@supreme/integration-layer";

export type { DriverConnectionStatus, DriverDiagnosticsSnapshot, DriverTraceEntry };

export interface DriverDiagnosticsStaticInfo {
  protocol: string;
  driverVersion: string;
  model?: string | null;
  firmware?: string | null;
  /** § Production Bugfix Sprint — a real UPnP-device-description `<serialNumber>` field
   * (see `parseUpnpDescription()`), when the discovery source fetched one. Optional
   * because most protocols/drivers have no such field; `null` (not omitted) once a
   * driver DOES report this concept, so the UI can distinguish "not applicable" from
   * "not yet threaded through" — same convention as `model`/`firmware`. */
  serial?: string | null;
  ip?: string | null;
  mac?: string | null;
}

/** Rolling window size for {@link DriverDiagnosticsTracker.averageLatencyMs} — recent
 * enough to reflect current network conditions, long enough that one slow outlier
 * doesn't swing the average. */
const LATENCY_WINDOW_SIZE = 20;

/** Bounded ring-buffer size for {@link DriverDiagnosticsTracker.recentTrace} — enough
 * history to diagnose a real issue without holding an unbounded log in memory for a
 * driver instance that lives for the process lifetime. */
const TRACE_BUFFER_SIZE = 200;

export class DriverDiagnosticsTracker {
  private packetsSent = 0;
  private packetsReceived = 0;
  private lastCommand: string | null = null;
  private lastCommandAt: string | null = null;
  private lastResponse: string | null = null;
  private lastResponseAt: string | null = null;
  private responseTimeMs: number | null = null;
  private pendingSentAtMs: number | null = null;
  private reconnectCount = 0;
  private lastError: string | null = null;
  /** § Universal AVR SDK — recent round-trip samples (ms), newest last, capped at
   * {@link LATENCY_WINDOW_SIZE}. Populated automatically by the SAME `recordSend`/
   * `recordReceive` pairing `responseTimeMs` already uses — every driver benefits with
   * zero driver-side changes, not just HTTP-based ones. `null` average until at least
   * one real round-trip has been measured (never a fabricated starting value). */
  private latencySamples: number[] = [];
  private trace: DriverTraceEntry[] = [];
  /** § RTI Capability Audit, Category C — defaults `true` (no "still syncing" window to
   * report) so a driver that never calls `setFullySynced` behaves exactly as before this
   * field existed. A driver that opts into the paced-handshake primitive
   * (`InitHandshake`) sets this `false` on connect and `true` once the handshake drains. */
  private fullySynced = true;

  /** A command/request was written to the wire. */
  recordSend(command: string): void {
    this.packetsSent += 1;
    this.lastCommand = command;
    this.lastCommandAt = new Date().toISOString();
    this.pendingSentAtMs = Date.now();
    this.recordTrace(`-> ${command}`);
  }

  /** A response/status line was read off the wire. */
  recordReceive(response: string): void {
    this.packetsReceived += 1;
    this.lastResponse = response;
    this.lastResponseAt = new Date().toISOString();
    if (this.pendingSentAtMs !== null) {
      this.responseTimeMs = Date.now() - this.pendingSentAtMs;
      this.pendingSentAtMs = null;
      this.latencySamples.push(this.responseTimeMs);
      if (this.latencySamples.length > LATENCY_WINDOW_SIZE) this.latencySamples.shift();
    }
    this.recordTrace(`<- ${response}`);
  }

  /** Real, rolling average of recent round-trip times — distinct from `responseTimeMs`
   * (the single most-recent sample) because one slow/fast outlier shouldn't define the
   * whole Diagnostics read. `null` until at least one sample exists. */
  averageLatencyMs(): number | null {
    if (this.latencySamples.length === 0) return null;
    return Math.round(this.latencySamples.reduce((a, b) => a + b, 0) / this.latencySamples.length);
  }

  /** § Universal AVR SDK — append one line to the bounded protocol-trace ring buffer.
   * Called automatically by `recordSend`/`recordReceive` (so every driver's real wire
   * traffic is always captured, independent of the separate opt-in `trace`/`onLog`
   * backend-log flag — this is a cheap, always-on, in-memory buffer for the Diagnostics
   * UI, not the verbose debugging log). Also callable directly for non-request/response
   * events worth recording (discovery steps, unrecognized lines). */
  recordTrace(line: string): void {
    this.trace.push({ at: new Date().toISOString(), line });
    if (this.trace.length > TRACE_BUFFER_SIZE) this.trace.shift();
  }

  /** The trace ring buffer's current contents, oldest first. */
  recentTrace(): DriverTraceEntry[] {
    return [...this.trace];
  }

  /** A reconnect attempt just fired (not the initial connect). */
  recordReconnect(): void {
    this.reconnectCount += 1;
  }

  /** A connection-level error occurred (socket error, failed request, …). */
  recordError(message: string): void {
    this.lastError = message;
  }

  /** § RTI Capability Audit, Category C — the driver calls this `false` when a fresh
   * connect/reconnect's init-sync handshake starts, and `true` once it fully drains. */
  setFullySynced(value: boolean): void {
    this.fullySynced = value;
  }

  snapshot(status: DriverConnectionStatus, info: DriverDiagnosticsStaticInfo): DriverDiagnosticsSnapshot {
    return {
      connectionStatus: status,
      protocol: info.protocol,
      driverVersion: info.driverVersion,
      model: info.model ?? null,
      firmware: info.firmware ?? null,
      serial: info.serial ?? null,
      ip: info.ip ?? null,
      mac: info.mac ?? null,
      lastCommand: this.lastCommand,
      lastCommandAt: this.lastCommandAt,
      lastResponse: this.lastResponse,
      lastResponseAt: this.lastResponseAt,
      responseTimeMs: this.responseTimeMs,
      averageLatencyMs: this.averageLatencyMs(),
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      reconnectCount: this.reconnectCount,
      lastError: this.lastError,
      fullySynced: this.fullySynced,
    };
  }
}
