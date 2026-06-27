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
  /** Broker base URL, e.g. "https://broker.supreme.example". */
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
    let frame: { t?: string; nonce?: string; id?: string; method?: string; path?: string; headers?: Record<string, string>; body?: string };
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
    }
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
