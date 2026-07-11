import { CoolMasterAsciiTransport } from "./coolmaster-ascii-protocol.js";
import { CoolMasterRestTransport } from "./coolmaster-rest-protocol.js";
import { cmdInfo, cmdLs2 } from "./coolmaster-commands.js";
import { parseGatewayInfo, parseLs2Block, parseUnitJsonList } from "./coolmaster-parser.js";
import { CoolMasterConnectionError, isRetryable } from "./coolmaster-errors.js";
import type { CoolMasterEventBus } from "./coolmaster-events.js";
import type { CoolMasterScopedLogger } from "./coolmaster-logger.js";
import type {
  CoolMasterConnectionState,
  CoolMasterGatewayInfo,
  CoolMasterUnitStatus,
  ResolvedCoolMasterConfig,
} from "./coolmaster-types.js";

/**
 * Owns both transports, picks which one serves a given request, and handles reconnect
 * with exponential backoff. ASCII_IF is ALWAYS connected (it is the only transport that
 * carries commands and gateway-identity bootstrap, per the REST scoping decision
 * documented in coolmaster-rest-protocol.ts); REST v2 is used opportunistically for
 * status polling when reachable and the configured protocol mode allows it.
 */
export class CoolMasterConnection {
  private readonly ascii: CoolMasterAsciiTransport;
  private readonly rest: CoolMasterRestTransport | null;
  private readonly logger: CoolMasterScopedLogger | undefined;
  private state: CoolMasterConnectionState = "disconnected";
  private gateway: CoolMasterGatewayInfo | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(
    private readonly config: ResolvedCoolMasterConfig,
    private readonly events: CoolMasterEventBus,
    logger?: CoolMasterScopedLogger,
  ) {
    this.logger = logger;
    this.ascii = new CoolMasterAsciiTransport({
      host: config.host,
      port: config.asciiPort,
      timeoutMs: config.timeoutMs,
      createSocket: config.createSocket,
      logger: logger,
      onUnexpectedClose: () => this.notifyDisconnected(),
    });
    this.rest =
      config.protocol === "ascii"
        ? null
        : new CoolMasterRestTransport({
            host: config.host,
            port: config.restPort,
            timeoutMs: config.timeoutMs,
            fetchImpl: config.fetchImpl,
            logger: logger,
          });
  }

  getState(): CoolMasterConnectionState {
    return this.state;
  }

  gatewayInfo(): CoolMasterGatewayInfo | null {
    return this.gateway;
  }

  isRestUsable(): boolean {
    return this.rest !== null && this.config.protocol !== "ascii" && this.rest.isReachable() && this.gateway !== null;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    await this.establish();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ascii.disconnect();
    this.setState("disconnected");
  }

  isConnected(): boolean {
    return this.ascii.isConnected();
  }

  /** Runs one ASCII_IF command with the configured retry count for transient failures. */
  async executeAscii(command: string): Promise<string[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.config.retryCount; attempt++) {
      try {
        if (!this.ascii.isConnected()) throw new CoolMasterConnectionError("coolmaster: ASCII_IF not connected", "ascii");
        return await this.ascii.execute(command);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === this.config.retryCount) break;
        this.logger?.debug("ascii retry", { command, attempt, error: (err as Error).message });
        await delay(this.backoffMs(attempt));
      }
    }
    this.events.emit({ type: "error", error: asError(lastErr), scope: "command" });
    throw lastErr;
  }

  /** Preferred status read: REST v2 ls2 when usable, ASCII_IF ls2 otherwise. Both paths
   * are normalized to the same CoolMasterUnitStatus[] by coolmaster-parser.ts. */
  async getUnitStatuses(): Promise<CoolMasterUnitStatus[]> {
    if (this.isRestUsable() && this.gateway) {
      try {
        const rows = await this.rest!.ls2(this.gateway.serial);
        return parseUnitJsonList(rows);
      } catch (err) {
        this.logger?.warn("REST ls2 failed, falling back to ASCII_IF", { error: (err as Error).message });
      }
    }
    const lines = await this.executeAscii(cmdLs2());
    return parseLs2Block(lines);
  }

  private async establish(): Promise<void> {
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    try {
      await this.ascii.connect();
      const infoLines = await this.ascii.execute(cmdInfo());
      this.gateway = parseGatewayInfo(infoLines, this.config.host);
      if (this.rest) {
        const reachable = await this.rest.probe();
        this.logger?.info("REST v2 probe", { reachable, restPort: this.config.restPort });
      }
      this.reconnectAttempt = 0;
      this.setState("connected");
      this.logger?.info("connected", { host: this.config.host, gateway: this.gateway });
    } catch (err) {
      this.events.emit({ type: "error", error: asError(err), scope: "connect" });
      this.scheduleReconnect();
    }
  }

  /** Called by coolmaster-driver.ts when the ASCII socket reports an unexpected close —
   * begins exponential-backoff reconnect unless disconnect() was called deliberately. */
  notifyDisconnected(): void {
    if (this.stopped) return;
    this.setState("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = this.backoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.logger?.info("scheduling reconnect", { delayMs, attempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.establish();
    }, delayMs);
    (this.reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  private backoffMs(attempt: number): number {
    const exp = this.config.backoffBaseMs * 2 ** attempt;
    return Math.min(exp, this.config.backoffMaxMs);
  }

  private setState(state: CoolMasterConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.emit({ type: "connection-state", state });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
