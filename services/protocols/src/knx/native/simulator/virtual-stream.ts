/**
 * SIMULATION INFRASTRUCTURE — in-memory, in-order, reliable byte streams (TCP semantics) with an on-path "tap" so tests can play a
 * network attacker (fragment, merge, drop, tamper, duplicate, replay). Cannot reach a real network by construction.
 */
import { markSimulated, type Clock, type KnxStreamSocket, type RemoteInfo, type StreamFactory, type StreamHandlers } from "../transport.js";

export type Direction = "client->server" | "server->client";
/** Receives each chunk written in `direction`; returns the chunks to actually deliver (possibly none, several, or altered). */
export type StreamTap = (direction: Direction, chunk: Buffer, conn: VirtualConnection) => Buffer[];

export interface ServerSide {
  readonly remote: RemoteInfo;
  write(data: Buffer): void;
  end(): void;
  destroy(): void;
  onData(fn: (d: Buffer) => void): void;
  onClose(fn: (e?: Error) => void): void;
}

export class VirtualConnection {
  readonly id: number;
  open = true;
  /** Set by destroy()/errors: in-flight bytes are lost (RST). A graceful end() still delivers everything written before it (FIN is ordered after data). */
  reset = false;
  clientHandlers: StreamHandlers | null = null;
  server!: ServerSide;
  private serverData: Array<(d: Buffer) => void> = [];
  private serverClose: Array<(e?: Error) => void> = [];
  constructor(private readonly net: VirtualStreamNetwork, id: number) { this.id = id; }
  _serverData(d: Buffer): void { for (const f of this.serverData) f(d); }
  _serverClose(e?: Error): void { for (const f of this.serverClose) f(e); }
  _registerServer(s: { data: (d: Buffer) => void; close: (e?: Error) => void }): void { this.serverData.push(s.data); this.serverClose.push(s.close); }
  get network(): VirtualStreamNetwork { return this.net; }
}

export class VirtualStreamNetwork {
  private readonly listeners = new Map<string, (c: ServerSide, conn: VirtualConnection) => void>();
  private nextPort = 51000;
  private nextId = 1;
  private readonly taps = new Set<StreamTap>();
  readonly connections: VirtualConnection[] = [];
  readonly stats = { connections: 0, refused: 0, bytesClientToServer: 0, bytesServerToClient: 0, resets: 0 };

  constructor(private readonly clock: Clock, private readonly latencyMs = 1) {}

  get openConnections(): number { return this.connections.filter((c) => c.open).length; }

  listen(address: string, port: number, onConnection: (c: ServerSide, conn: VirtualConnection) => void): () => void {
    const k = `${address}:${port}`;
    if (this.listeners.has(k)) throw new Error(`virtual stream endpoint ${k} already bound`);
    this.listeners.set(k, onConnection);
    return () => { this.listeners.delete(k); };
  }

  /** Adds an on-path tap; returns remove(). Taps are applied in insertion order. */
  tap(fn: StreamTap): () => void { this.taps.add(fn); return () => { this.taps.delete(fn); }; }

  /** `fragment` optionally re-chunks every client write (models TCP segmentation); the tap model covers the rest. */
  createStreamFactory(clientAddress: string, targetAddress: string, targetPort: number): StreamFactory {
    return markSimulated((handlers: StreamHandlers): KnxStreamSocket => {
      const accept = this.listeners.get(`${targetAddress}:${targetPort}`);
      if (!accept) { this.stats.refused++; throw new Error(`ECONNREFUSED ${targetAddress}:${targetPort}`); }
      const conn = new VirtualConnection(this, this.nextId++);
      conn.clientHandlers = handlers;
      this.connections.push(conn);
      this.stats.connections++;
      const remote: RemoteInfo = { address: clientAddress, port: this.nextPort++ };
      let clientDestroyed = false;

      const deliver = (dir: Direction, data: Buffer): void => {
        if (!conn.open) return;
        let chunks: Buffer[] = [Buffer.from(data)];
        for (const t of this.taps) chunks = chunks.flatMap((c) => t(dir, c, conn));
        for (const c of chunks) {
          if (dir === "client->server") this.stats.bytesClientToServer += c.length; else this.stats.bytesServerToClient += c.length;
          this.clock.setTimeout(() => {
            if (conn.reset) return;
            if (dir === "client->server") conn._serverData(c); else if (!clientDestroyed) conn.clientHandlers?.onData(c);
          }, this.latencyMs);
        }
      };
      const closeBoth = (who: "client" | "server", error?: Error): void => {
        if (!conn.open) return;
        conn.open = false;
        if (error) { this.stats.resets++; conn.reset = true; }
        this.clock.setTimeout(() => {
          if (who === "client") conn._serverClose(error); else if (!clientDestroyed) conn.clientHandlers?.onClose(error);
        }, this.latencyMs);
      };

      conn.server = {
        remote,
        write: (d) => deliver("server->client", d),
        end: () => closeBoth("server"),
        destroy: () => closeBoth("server", new Error("connection reset by server")),
        onData: (fn) => conn._registerServer({ data: fn, close: () => undefined }),
        onClose: (fn) => conn._registerServer({ data: () => undefined, close: fn }),
      };
      // the server learns of the connection one latency later, like a real accept()
      this.clock.setTimeout(() => accept(conn.server, conn), this.latencyMs);

      return {
        write: (d) => { if (!clientDestroyed) deliver("client->server", d); },
        end: () => { if (!clientDestroyed) closeBoth("client"); },
        destroy: () => { if (clientDestroyed) return; clientDestroyed = true; closeBoth("client", new Error("connection reset by client")); },
      };
    });
  }
}
