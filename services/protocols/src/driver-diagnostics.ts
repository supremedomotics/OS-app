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

import type { DriverConnectionStatus, DriverDiagnosticsSnapshot } from "@supreme/integration-layer";

export type { DriverConnectionStatus, DriverDiagnosticsSnapshot };

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

  /** A command/request was written to the wire. */
  recordSend(command: string): void {
    this.packetsSent += 1;
    this.lastCommand = command;
    this.lastCommandAt = new Date().toISOString();
    this.pendingSentAtMs = Date.now();
  }

  /** A response/status line was read off the wire. */
  recordReceive(response: string): void {
    this.packetsReceived += 1;
    this.lastResponse = response;
    this.lastResponseAt = new Date().toISOString();
    if (this.pendingSentAtMs !== null) {
      this.responseTimeMs = Date.now() - this.pendingSentAtMs;
      this.pendingSentAtMs = null;
    }
  }

  /** A reconnect attempt just fired (not the initial connect). */
  recordReconnect(): void {
    this.reconnectCount += 1;
  }

  /** A connection-level error occurred (socket error, failed request, …). */
  recordError(message: string): void {
    this.lastError = message;
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
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      reconnectCount: this.reconnectCount,
      lastError: this.lastError,
    };
  }
}
