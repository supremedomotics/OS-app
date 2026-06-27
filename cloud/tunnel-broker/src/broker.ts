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
interface Conn {
  socket: BrokerSocket;
  pending: Map<string, Pending>;
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

  /** Attach an authenticated hub connection. Returns a detach function. */
  attach(hubId: string, socket: BrokerSocket): () => void {
    const conn: Conn = { socket, pending: new Map() };
    // A new connection for the same hub replaces the old (reconnect); fail the old's pendings.
    const prev = this.conns.get(hubId);
    if (prev) for (const p of prev.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("superseded by new connection"));
    }
    this.conns.set(hubId, conn);
    return () => {
      if (this.conns.get(hubId) === conn) this.conns.delete(hubId);
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("tunnel closed"));
      }
    };
  }

  isOnline(hubId: string): boolean {
    return this.conns.has(hubId);
  }

  /** Handle a response frame coming back from a hub. */
  handleMessage(hubId: string, raw: string): void {
    const conn = this.conns.get(hubId);
    if (!conn) return;
    let frame: { t?: string; id?: string } & Partial<TunnelResponse>;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.t !== "res" || !frame.id) return;
    const pending = conn.pending.get(frame.id);
    if (!pending) return;
    conn.pending.delete(frame.id);
    clearTimeout(pending.timer);
    pending.resolve({ status: frame.status ?? 502, headers: frame.headers ?? {}, body: frame.body ?? "" });
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
