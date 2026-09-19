import { randomBytes } from "node:crypto";
import {
  verifyHubPresentation,
  type DeviceCredential,
} from "@supreme/hub-identity";

/**
 * Zero-trust Tunnel Broker core (ADR 0009, blueprint §7). The cert-authenticated evolution of
 * the Phase-1 relay: hubs are keyed by `hubId` extracted from a VERIFIED device credential
 * (not a shared token + homeId), and a hub proves possession of its device key via a
 * challenge-response handshake before its connection is attached.
 *
 * The broker is a TRANSPORT, not a man-in-the-middle: it forwards request/response frames over
 * the hub's socket and the hub re-validates identity + RBAC locally. Transport-agnostic (just
 * `send`) so it is unit-testable without a server.
 */
export interface BrokerSocket {
  send(data: string): void;
}

export interface TunnelRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}
export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The auth frame a hub sends after the broker's challenge (proof-of-possession). */
export interface HubHandshake {
  credential: DeviceCredential;
  challengeSignature: string;
}

export interface HandshakeResult {
  ok: boolean;
  hubId?: string;
  reason?: string;
}

interface Pending {
  resolve: (res: TunnelResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** §Phase12.9 — a live tunnelled stream (e.g. `/v1/stream`), multiplexed by `id` over the SAME
 * hub tunnel socket the req/res forwarding above already uses. No second socket, no second
 * broker endpoint per hub — one dial-out connection carries both request/response traffic and
 * any number of concurrent streams. */
export interface StreamHandlers {
  onData: (data: string) => void;
  onClose: (code?: number, reason?: string) => void;
}
interface StreamHandle {
  handlers: StreamHandlers;
}
interface Conn {
  socket: BrokerSocket;
  pending: Map<string, Pending>;
  streams: Map<string, StreamHandle>;
  /** The Hub's own Ed25519 device public key (SPKI PEM), as verified by `verifyHandshake` —
   * retained so `authorizeClient` (§Phase12) can verify a Mobile authorization token's
   * signature without any further trust decision: this is the SAME key the handshake above
   * already proved possession of. */
  devicePublicKey: string;
}

let counter = 0;

export interface TunnelBrokerOptions {
  /** Public key of the Hub CA whose credentials this broker trusts. */
  caPublicKey: string;
  now?: () => number;
}

export class TunnelBroker {
  private readonly conns = new Map<string, Conn>();
  private readonly caPublicKey: string;
  private readonly now: () => number;

  constructor(opts: TunnelBrokerOptions) {
    this.caPublicKey = opts.caPublicKey;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Issue a per-connection challenge nonce the hub must sign with its device key. */
  issueChallenge(): string {
    return randomBytes(24).toString("base64url");
  }

  /**
   * Verify a hub's handshake: the credential must be CA-signed and unexpired, and the hub must
   * have signed THIS challenge with the device key bound to the credential. Returns the hubId
   * to key the connection by.
   */
  verifyHandshake(frame: HubHandshake, challenge: string): HandshakeResult {
    const check = verifyHubPresentation(
      frame.credential,
      this.caPublicKey,
      challenge,
      frame.challengeSignature,
      this.now(),
    );
    if (!check.valid) return { ok: false, reason: check.reason };
    return { ok: true, hubId: frame.credential.hubUuid };
  }

  /** Attach an authenticated hub connection. Returns a detach function. `devicePublicKey`
   * (SPKI PEM) is needed only so `authorizeClient`'s default verifier (§Phase12) can check
   * Mobile-authorization tokens for this hub; callers that don't have it yet (e.g. the mTLS
   * listener, which authenticates via X.509 CN rather than this Ed25519 credential — see
   * `mtls.ts`) may omit it, but Mobile remote access for those hubs then always fails closed
   * (an empty key never verifies a real signature) rather than silently succeeding. */
  attach(hubId: string, socket: BrokerSocket, devicePublicKey = ""): () => void {
    const conn: Conn = { socket, pending: new Map(), streams: new Map(), devicePublicKey };
    // A new connection for the same hub replaces the old (reconnect); fail the old's pendings.
    const prev = this.conns.get(hubId);
    if (prev) {
      for (const p of prev.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("superseded by new connection"));
      }
      for (const s of prev.streams.values()) s.handlers.onClose(1001, "superseded by new connection");
    }
    this.conns.set(hubId, conn);
    return () => {
      if (this.conns.get(hubId) === conn) this.conns.delete(hubId);
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("tunnel closed"));
      }
      for (const s of conn.streams.values()) s.handlers.onClose(1011, "tunnel closed");
      conn.streams.clear();
    };
  }

  isOnline(hubId: string): boolean {
    return this.conns.has(hubId);
  }

  /** The device public key this hub proved possession of at handshake — used to verify
   * Mobile authorization tokens (§Phase12) claiming to be authorized for this exact hub.
   * Undefined when the hub isn't currently attached (tokens can't be verified for an
   * offline hub anyway; `authorizeClient` should treat that as "not authorized" too). */
  getHubPublicKey(hubId: string): string | undefined {
    return this.conns.get(hubId)?.devicePublicKey;
  }

  /** Handle a response/stream frame coming back from a hub. */
  handleMessage(hubId: string, raw: string): void {
    const conn = this.conns.get(hubId);
    if (!conn) return;
    let frame: { t?: string; id?: string; data?: string; code?: number; reason?: string } & Partial<TunnelResponse>;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.t === "res" && frame.id) {
      const pending = conn.pending.get(frame.id);
      if (!pending) return;
      conn.pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.resolve({ status: frame.status ?? 502, headers: frame.headers ?? {}, body: frame.body ?? "" });
      return;
    }
    if (frame.t === "stream_data" && frame.id) {
      conn.streams.get(frame.id)?.handlers.onData(frame.data ?? "");
      return;
    }
    if (frame.t === "stream_close" && frame.id) {
      const stream = conn.streams.get(frame.id);
      if (!stream) return;
      conn.streams.delete(frame.id);
      stream.handlers.onClose(frame.code, frame.reason);
      return;
    }
  }

  /** §Phase12.9 — opens a live stream to `path` (e.g. `/v1/stream?access_token=...`) on the
   * hub's LOCAL gateway, multiplexed over the hub's existing tunnel socket. Returns `null` when
   * the hub is offline (fail closed — caller must not fabricate a stream). The caller must call
   * the returned `close()` when the client side disconnects, and must treat `onClose` as
   * terminal (never auto-reopened here — that policy belongs to the client, same as
   * `WebSocketHubEventStream`'s own reconnect logic). */
  openStream(hubId: string, path: string, handlers: StreamHandlers): { id: string; send: (data: string) => void; close: () => void } | null {
    const conn = this.conns.get(hubId);
    if (!conn) return null;
    const id = `s${this.now().toString(36)}${(counter++).toString(36)}`;
    conn.streams.set(id, { handlers });
    conn.socket.send(JSON.stringify({ t: "stream_open", id, path }));
    return {
      id,
      send: (data: string) => conn.socket.send(JSON.stringify({ t: "stream_data", id, data })),
      close: () => {
        if (conn.streams.delete(id)) conn.socket.send(JSON.stringify({ t: "stream_close", id }));
      },
    };
  }

  /** Forward a client request to the hub over its tunnel and await the response. */
  forward(hubId: string, req: TunnelRequest, timeoutMs = 15000): Promise<TunnelResponse> {
    const conn = this.conns.get(hubId);
    if (!conn) return Promise.reject(new Error("hub offline"));
    const id = `r${this.now().toString(36)}${(counter++).toString(36)}`;
    return new Promise<TunnelResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error("tunnel timeout"));
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      conn.socket.send(JSON.stringify({ t: "req", id, ...req }));
    });
  }
}
