/**
 * Hub side of the remote-access relay (§8). The hub dials OUT to the cloud relay and
 * holds the socket open — no inbound ports on the home. When an off-LAN client request
 * arrives over the tunnel, the hub forwards it to its OWN local gateway (so identity is
 * validated on the hub, exactly as on the LAN) and returns the response. Auto-reconnects.
 *
 * Uses the browser-style WebSocket API so Node's global `WebSocket` works out of the
 * box; the ctor + fetch are injectable for tests.
 */
export interface RelayWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}
export type RelayWebSocketCtor = new (url: string) => RelayWebSocket;

export interface RelayTunnelOptions {
  /** Relay base URL, e.g. "https://cloud.supreme.example". */
  relayUrl: string;
  homeId: string;
  token: string;
  /** This hub's local gateway base, e.g. "http://127.0.0.1:8080". */
  localBaseUrl: string;
  WebSocketImpl?: RelayWebSocketCtor;
  fetchImpl?: typeof fetch;
  /** Reconnect backoff base in ms (default 2000). */
  reconnectMs?: number;
}

interface ReqFrame {
  t: "req";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export class RelayTunnelClient {
  private ws: RelayWebSocket | null = null;
  private stopped = false;
  private readonly ctor: RelayWebSocketCtor;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RelayTunnelOptions) {
    this.ctor = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as RelayWebSocketCtor);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const base = this.opts.relayUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const url = `${base}/v1/tunnel?home=${encodeURIComponent(this.opts.homeId)}&token=${encodeURIComponent(this.opts.token)}`;
    const ws = new this.ctor(url);
    this.ws = ws;
    ws.addEventListener("message", (ev) => void this.onFrame(String(ev.data)));
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) {
        const t = setTimeout(() => this.connect(), this.opts.reconnectMs ?? 2000);
        (t as { unref?: () => void }).unref?.();
      }
    });
  }

  private async onFrame(raw: string): Promise<void> {
    let frame: ReqFrame;
    try {
      frame = JSON.parse(raw) as ReqFrame;
    } catch {
      return;
    }
    if (frame.t !== "req") return;
    const res = await this.proxyLocal(frame);
    this.ws?.send(JSON.stringify({ t: "res", id: frame.id, ...res }));
  }

  private async proxyLocal(frame: ReqFrame): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    // Only the PUBLIC API contract is reachable over the relay — mirror the edge proxy.
    // The tunnel bypasses Caddy, so without this allow-list a remote client could reach
    // internal-only endpoints (/metrics, /readyz) that are intentionally unauthenticated
    // and never exposed at the public edge.
    const pathname = frame.path.split("?")[0] ?? "";
    if (pathname !== "/healthz" && !pathname.startsWith("/v1/")) {
      return { status: 404, headers: {}, body: JSON.stringify({ code: "not_found" }) };
    }
    try {
      const res = await this.fetchImpl(`${this.opts.localBaseUrl.replace(/\/$/, "")}${frame.path}`, {
        method: frame.method,
        headers: frame.headers,
        body: frame.method === "GET" || frame.method === "HEAD" ? undefined : frame.body,
      });
      const headers: Record<string, string> = {};
      const ct = res.headers.get("content-type");
      if (ct) headers["content-type"] = ct;
      return { status: res.status, headers, body: await res.text() };
    } catch (err) {
      return { status: 502, headers: {}, body: JSON.stringify({ code: "hub_error", message: (err as Error).message }) };
    }
  }
}
