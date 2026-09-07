import { ServerFrame, type ClientFrame } from "@supreme/contracts";

/**
 * Typed WSS client for `/v1/stream`. Wraps the realtime contract so clients
 * subscribe to rooms and receive validated, typed {@link ServerFrame}s. The
 * underlying WebSocket constructor is injected for browser/node portability.
 */
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}

export interface StreamHandlers {
  onState?: (frame: Extract<ServerFrame, { type: "state" }>) => void;
  onAck?: (frame: Extract<ServerFrame, { type: "ack" }>) => void;
  onNotification?: (frame: Extract<ServerFrame, { type: "notification" }>) => void;
  /** § Realtime State Architecture — driver connect/disconnect/error transitions,
   * distinct from device capability deltas (onState). See DriverStateFrame. */
  onDriverState?: (frame: Extract<ServerFrame, { type: "driver" }>) => void;
  /** Fires on every successful (re)connection — not just the first. A caller that
   * re-subscribes and re-fetches an authoritative snapshot here (rather than only
   * once, outside `connect()`) survives reconnects automatically (§ Reconnection
   * Handling): resubscribing rooms replays nothing retroactively (the server sends no
   * backlog), so pairing this with a REST reconciliation fetch is what actually closes
   * the gap for whatever changed while disconnected. */
  onOpen?: () => void;
  /** Fires on every close, reconnect attempts or not — a caller can use this to show
   * transient "reconnecting" UI, distinct from onOpen's "resync now" signal. */
  onClose?: () => void;
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// § Live-confirmed fix — a FLAPPING connection (opens, then drops again within a
// couple seconds — real symptom observed on a network with intermittent connectivity
// issues) defeated exponential backoff entirely: `backoffMs` reset to `BASE_BACKOFF_MS`
// the instant "open" fired, before the connection had proven it would actually stay up,
// so a socket that kept briefly opening and immediately dying reconnected at roughly
// the base interval forever instead of backing off — and every "open" also fires
// `onOpen` (a full REST reconciliation fetch, see App.tsx's `reconcileSnapshot`), so a
// flapping socket compounded into hundreds of queued/competing requests, live-confirmed
// crowding out an unrelated large upload on the same origin. The backoff now resets
// only after the connection has genuinely stayed open for this long — a socket that
// dies faster than this keeps escalating, exactly like a normal broken connection.
const STABLE_CONNECTION_MS = 10_000;

export class SupremeStream {
  private ws: WebSocketLike | null = null;
  private handlers: StreamHandlers = {};
  private subscribedRooms = new Set<string>();
  private reconnectEnabled = false;
  private backoffMs = BASE_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly wsBaseUrl: string,
    private readonly accessToken: string,
    private readonly ctor: WebSocketCtor,
  ) {}

  /**
   * § Reconnection Handling — the transport reconnects itself (exponential backoff,
   * capped) on any unexpected close, rather than leaving the caller responsible for
   * noticing a dead socket and recreating one. `close()` is the only way to stop this.
   */
  connect(handlers: StreamHandlers): void {
    this.handlers = handlers;
    this.reconnectEnabled = true;
    this.openSocket();
  }

  private openSocket(): void {
    const url = `${this.wsBaseUrl.replace(/\/$/, "")}/v1/stream?access_token=${this.accessToken}`;
    const ws = new this.ctor(url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      // Only counts as "recovered" once it's proven it can stay up — see
      // STABLE_CONNECTION_MS's own doc comment above for why this isn't reset here.
      this.stableTimer = setTimeout(() => { this.backoffMs = BASE_BACKOFF_MS; }, STABLE_CONNECTION_MS);
      // § Avoid Duplicate Event Listeners / subscriptions — re-issue exactly the rooms
      // this client had subscribed to before the drop, not a fresh empty subscription
      // set the caller has to remember to rebuild.
      if (this.subscribedRooms.size > 0) this.send({ type: "subscribe", rooms: [...this.subscribedRooms] });
      this.handlers.onOpen?.();
    });
    ws.addEventListener("close", () => {
      if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
      this.handlers.onClose?.();
      if (!this.reconnectEnabled) return;
      this.reconnectTimer = setTimeout(() => this.openSocket(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    });
    ws.addEventListener("message", (ev) => {
      const parsed = ServerFrame.safeParse(JSON.parse(String(ev.data)));
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.type === "state") this.handlers.onState?.(frame);
      else if (frame.type === "ack") this.handlers.onAck?.(frame);
      else if (frame.type === "notification") this.handlers.onNotification?.(frame);
      else if (frame.type === "driver") this.handlers.onDriverState?.(frame);
    });
  }

  subscribe(rooms: string[]): void {
    for (const r of rooms) this.subscribedRooms.add(r);
    this.send({ type: "subscribe", rooms });
  }
  unsubscribe(rooms: string[]): void {
    for (const r of rooms) this.subscribedRooms.delete(r);
    this.send({ type: "unsubscribe", rooms });
  }
  ping(): void {
    this.send({ type: "ping" });
  }

  private send(frame: ClientFrame): void {
    this.ws?.send(JSON.stringify(frame));
  }

  close(): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.ws?.close();
    this.ws = null;
  }
}
