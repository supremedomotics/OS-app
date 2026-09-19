import { signChallenge, type DeviceCredential, type HubIdentity } from "@supreme/hub-identity";

/**
 * Hub side of the zero-trust Tunnel Broker (ADR 0009) — the cert-authenticated evolution of
 * `relay-tunnel.ts`. The hub dials OUT to the broker (no inbound ports), proves possession of
 * its device key by signing the broker's challenge, then holds the socket open. Forwarded
 * client requests are proxied to the hub's OWN local gateway, so identity + RBAC are enforced
 * locally exactly as on the LAN. Auto-reconnects.
 */
export interface BrokerWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}
export type BrokerWebSocketCtor = new (url: string) => BrokerWebSocket;

export interface BrokerTunnelOptions {
  /** Broker base URL, e.g. "https://broker.supremedomotics.in". */
  brokerUrl: string;
  /** The hub's identity (device private key signs the challenge). */
  identity: HubIdentity;
  /** The CA-issued device credential presented during the handshake. */
  credential: DeviceCredential;
  /** This hub's local gateway base, e.g. "http://127.0.0.1:8080". */
  localBaseUrl: string;
  WebSocketImpl?: BrokerWebSocketCtor;
  fetchImpl?: typeof fetch;
  reconnectMs?: number;
  onReady?: () => void;
}

interface ReqFrame {
  t: "req";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export class BrokerTunnelClient {
  private ws: BrokerWebSocket | null = null;
  private stopped = false;
  private authed = false;
  private readonly ctor: BrokerWebSocketCtor;
  private readonly fetchImpl: typeof fetch;
  /** §Phase12.9 — local WebSockets opened on THIS hub's own gateway (e.g. `/v1/stream`) on
   * behalf of a remote broker-side stream, keyed by the broker's stream id. Each one is a real
   * connection to `localBaseUrl`'s own stream endpoint — auth/RBAC is enforced there exactly as
   * on the LAN; the tunnel only relays bytes. */
  private readonly localStreams = new Map<string, BrokerWebSocket>();

  constructor(private readonly opts: BrokerTunnelOptions) {
    this.ctor = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as BrokerWebSocketCtor);
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
    for (const local of this.localStreams.values()) local.close();
    this.localStreams.clear();
  }

  private connect(): void {
    if (this.stopped) return;
    const base = this.opts.brokerUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const ws = new this.ctor(`${base}/v1/hub/tunnel`);
    this.ws = ws;
    this.authed = false;
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
    let frame: {
      t?: string;
      nonce?: string;
      id?: string;
      method?: string;
      path?: string;
      headers?: Record<string, string>;
      body?: string;
      data?: string;
    };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    // Step 1: answer the broker's challenge with a signature over the nonce + our credential.
    if (frame.t === "challenge" && frame.nonce) {
      this.ws?.send(
        JSON.stringify({
          t: "auth",
          credential: this.opts.credential,
          challengeSignature: signChallenge(frame.nonce, this.opts.identity.privateKey),
        }),
      );
      return;
    }
    if (frame.t === "ready") {
      this.authed = true;
      this.opts.onReady?.();
      return;
    }
    // Step 2 (post-auth): proxy forwarded client requests to the local gateway.
    if (frame.t === "req" && this.authed) {
      const res = await this.proxyLocal(frame as ReqFrame);
      this.ws?.send(JSON.stringify({ t: "res", id: (frame as ReqFrame).id, ...res }));
      return;
    }
    // §Phase12.9 — a remote client wants a live stream (e.g. `/v1/stream`): open a REAL local
    // WebSocket to this hub's own gateway and relay bytes both ways. Local auth/RBAC applies
    // exactly as it would on the LAN — the tunnel adds no privilege.
    if (frame.t === "stream_open" && this.authed && frame.id && frame.path) {
      this.openLocalStream(frame.id, frame.path);
      return;
    }
    if (frame.t === "stream_data" && frame.id && frame.data !== undefined) {
      const local = this.localStreams.get(frame.id);
      if (local) local.send(frame.data);
      else this.pendingStreamFrames.get(frame.id)?.push(frame.data) ?? this.pendingStreamFrames.set(frame.id, [frame.data]);
      return;
    }
    if (frame.t === "stream_close" && frame.id) {
      this.localStreams.get(frame.id)?.close();
      this.localStreams.delete(frame.id);
      this.pendingStreamFrames.delete(frame.id);
      return;
    }
  }

  /** Frames the broker relayed before this hub's own local WebSocket finished connecting —
   * the remote client can send data the instant `stream_open` is acked, well before a real
   * `ws` handshake to `localBaseUrl` completes. Queued, not dropped, and flushed in order. */
  private readonly pendingStreamFrames = new Map<string, string[]>();

  private openLocalStream(streamId: string, path: string): void {
    const base = this.opts.localBaseUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const local = new this.ctor(`${base}${path}`);
    local.addEventListener("open", () => {
      this.localStreams.set(streamId, local);
      for (const data of this.pendingStreamFrames.get(streamId) ?? []) local.send(data);
      this.pendingStreamFrames.delete(streamId);
    });
    local.addEventListener("message", (ev) => {
      this.ws?.send(JSON.stringify({ t: "stream_data", id: streamId, data: String(ev.data) }));
    });
    local.addEventListener("close", () => {
      this.localStreams.delete(streamId);
      this.ws?.send(JSON.stringify({ t: "stream_close", id: streamId }));
    });
  }

  private async proxyLocal(frame: ReqFrame): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    // Only the PUBLIC API contract is reachable over the tunnel (mirror the edge allow-list);
    // the hub also re-checks. Without this a remote client could reach internal-only endpoints.
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
