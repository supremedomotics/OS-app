/**
 * Remote-access relay (§8) — the OUTBOUND-only tunnel. A hub dials the cloud and holds
 * a persistent socket; the home opens NO inbound ports. Off-LAN clients hit the relay,
 * which forwards their request over the matching hub's socket and returns the hub's
 * response. Identity is still validated on the hub (the relay only transports), so the
 * relay never sees plaintext credentials beyond bearer headers it blindly forwards.
 *
 * This core is transport-agnostic (just `send`) so it's unit-testable without a server.
 */
export interface RelaySocket {
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

interface Pending {
  resolve: (res: TunnelResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Conn {
  socket: RelaySocket;
  pending: Map<string, Pending>;
}

let counter = 0;

export class TunnelRegistry {
  private readonly conns = new Map<string, Conn>();

  /** Register a hub's tunnel socket. Returns an unregister function. */
  register(homeId: string, socket: RelaySocket): () => void {
    const conn: Conn = { socket, pending: new Map() };
    this.conns.set(homeId, conn);
    return () => {
      if (this.conns.get(homeId) === conn) this.conns.delete(homeId);
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("tunnel closed"));
      }
    };
  }

  isOnline(homeId: string): boolean {
    return this.conns.has(homeId);
  }

  /** Handle an inbound frame from a hub (a response to a forwarded request). */
  handleMessage(homeId: string, raw: string): void {
    const conn = this.conns.get(homeId);
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
    pending.resolve({
      status: frame.status ?? 502,
      headers: frame.headers ?? {},
      body: frame.body ?? "",
    });
  }

  /** Forward a client request to the hub over its tunnel and await the response. */
  request(homeId: string, req: TunnelRequest, timeoutMs = 15000): Promise<TunnelResponse> {
    const conn = this.conns.get(homeId);
    if (!conn) return Promise.reject(new Error("hub offline"));
    const id = `r${Date.now().toString(36)}${(counter++).toString(36)}`;
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
