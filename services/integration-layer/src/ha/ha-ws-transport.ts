import { WebSocket } from "ws";
import type { HaTransport } from "./ha-adapter.js";

/**
 * Concrete Home Assistant WebSocket transport (§7). Implements HA's WS protocol:
 * the `auth_required` → `auth` → `auth_ok` handshake, id-correlated commands
 * (`call_service`, `get_states`), and a `state_changed` event subscription.
 *
 * This is the lowest, HA-specific edge of the SIL. It is injected into `HaAdapter`
 * at the hub boot edge (where the loopback HA URL + long-lived token live) so the
 * adapter's resilience logic stays transport-agnostic and unit-testable.
 *
 * The long-lived token is held ONLY here; it never surfaces above the SIL.
 */
export interface HaWsTransportOptions {
  url: string;
  token: string;
  /** Reconnect backoff schedule in ms. */
  backoffMs?: number[];
}

interface Pending {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

export class HaWsTransport implements HaTransport {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private authed = false;
  private closing = false;
  private readonly pending = new Map<number, Pending>();
  private eventHandler: ((event: Record<string, unknown>) => void) | null = null;
  private readonly backoff: number[];
  private reconnectAttempt = 0;

  constructor(private readonly opts: HaWsTransportOptions) {
    this.backoff = opts.backoffMs ?? [1000, 2000, 4000, 8000, 16000];
  }

  isOpen(): boolean {
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  onEvent(handler: (event: Record<string, unknown>) => void): void {
    this.eventHandler = handler;
  }

  async open(): Promise<void> {
    this.closing = false;
    await this.connectAndAuth();
    await this.subscribeStateChanged();
    this.reconnectAttempt = 0;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.authed = false;
    this.ws?.close();
    this.ws = null;
    for (const [, p] of this.pending) p.reject(new Error("transport closed"));
    this.pending.clear();
  }

  /** Send an HA WS command and await its `result` message. */
  send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authed) {
      return Promise.reject(new Error("HA transport not connected"));
    }
    const id = this.nextId++;
    const frame = { ...message, id };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(frame), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private connectAndAuth(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      this.authed = false;

      ws.on("message", (raw) => this.onMessage(raw.toString(), resolve, reject));
      ws.on("error", (err) => {
        if (!this.authed) reject(err);
      });
      ws.on("close", () => {
        this.authed = false;
        if (!this.closing) this.scheduleReconnect();
      });
    });
  }

  private onMessage(
    text: string,
    onAuth: () => void,
    onAuthFail: (err: Error) => void,
  ): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.type) {
      case "auth_required":
        this.ws?.send(JSON.stringify({ type: "auth", access_token: this.opts.token }));
        return;
      case "auth_ok":
        this.authed = true;
        onAuth();
        return;
      case "auth_invalid":
        onAuthFail(new Error(`HA auth failed: ${String(msg.message ?? "invalid token")}`));
        return;
      case "result": {
        const id = msg.id as number;
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          if (msg.success === false) {
            p.reject(new Error(`HA command ${id} failed: ${JSON.stringify(msg.error)}`));
          } else {
            p.resolve(msg);
          }
        }
        return;
      }
      case "event": {
        // Deliver the inner HA event (which carries `.data.entity_id/new_state`).
        const event = msg.event as Record<string, unknown> | undefined;
        if (event && this.eventHandler) this.eventHandler(event);
        return;
      }
      default:
        return;
    }
  }

  private async subscribeStateChanged(): Promise<void> {
    await this.send({ type: "subscribe_events", event_type: "state_changed" });
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    const delay = this.backoff[Math.min(this.reconnectAttempt, this.backoff.length - 1)]!;
    this.reconnectAttempt++;
    setTimeout(() => {
      if (this.closing) return;
      void this.open().catch(() => this.scheduleReconnect());
    }, delay).unref?.();
  }
}
