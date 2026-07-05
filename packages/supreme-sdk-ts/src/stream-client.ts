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
  onOpen?: () => void;
  onClose?: () => void;
}

export class SupremeStream {
  private ws: WebSocketLike | null = null;

  constructor(
    private readonly wsBaseUrl: string,
    private readonly accessToken: string,
    private readonly ctor: WebSocketCtor,
  ) {}

  connect(handlers: StreamHandlers): void {
    const url = `${this.wsBaseUrl.replace(/\/$/, "")}/v1/stream?access_token=${this.accessToken}`;
    const ws = new this.ctor(url);
    this.ws = ws;
    ws.addEventListener("open", () => handlers.onOpen?.());
    ws.addEventListener("close", () => handlers.onClose?.());
    ws.addEventListener("message", (ev) => {
      const parsed = ServerFrame.safeParse(JSON.parse(String(ev.data)));
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.type === "state") handlers.onState?.(frame);
      else if (frame.type === "ack") handlers.onAck?.(frame);
      else if (frame.type === "notification") handlers.onNotification?.(frame);
    });
  }

  subscribe(rooms: string[]): void {
    this.send({ type: "subscribe", rooms });
  }
  unsubscribe(rooms: string[]): void {
    this.send({ type: "unsubscribe", rooms });
  }
  ping(): void {
    this.send({ type: "ping" });
  }

  private send(frame: ClientFrame): void {
    this.ws?.send(JSON.stringify(frame));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
