/**
 * SIMULATION INFRASTRUCTURE — in-memory UDP fabric with deterministic fault injection
 * (loss, delay, duplication, corruption). Cannot reach a real network by construction.
 */
import type { Clock, KnxDatagramSocket, RemoteInfo, SocketFactory, SocketHandlers } from "../transport.js";

export interface PacketInfo {
  from: RemoteInfo;
  to: RemoteInfo;
  data: Buffer;
  /** KNXnet/IP service type if the datagram has a plausible header, else null. */
  service: number | null;
}

export type NetworkAction = "drop" | "duplicate" | "corrupt" | "delay";

export interface NetworkRule {
  match(p: PacketInfo): boolean;
  action: NetworkAction;
  /** How many matching packets to affect; default unlimited. */
  times?: number;
  delayMs?: number;
  corrupt?(data: Buffer): Buffer;
}

export interface NetworkStats { sent: number; delivered: number; dropped: number; duplicated: number; corrupted: number; delayed: number; noRoute: number }

type DatagramHandler = (data: Buffer, from: RemoteInfo) => void;

const key = (a: RemoteInfo): string => `${a.address}:${a.port}`;

export class VirtualNetwork {
  private readonly listeners = new Map<string, DatagramHandler>();
  private readonly rules: Array<NetworkRule & { remaining: number }> = [];
  private nextPort = 49152;
  readonly stats: NetworkStats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0, corrupted: 0, delayed: 0, noRoute: 0 };

  constructor(private readonly clock: Clock, private readonly latencyMs = 1) {}

  /** Registers a server endpoint. Returns a detach function. */
  listen(address: string, port: number, handler: DatagramHandler): () => void {
    const k = key({ address, port });
    if (this.listeners.has(k)) throw new Error(`virtual endpoint ${k} already bound`);
    this.listeners.set(k, handler);
    return () => { this.listeners.delete(k); };
  }

  /** Sends from a server endpoint (used by the virtual interface). */
  sendFrom(from: RemoteInfo, to: RemoteInfo, data: Buffer): void { this.route(from, to, data); }

  addRule(rule: NetworkRule): () => void {
    const r = { ...rule, remaining: rule.times ?? Number.POSITIVE_INFINITY };
    this.rules.push(r);
    return () => { const i = this.rules.indexOf(r); if (i >= 0) this.rules.splice(i, 1); };
  }

  clearRules(): void { this.rules.length = 0; }

  /** Number of client sockets currently open (leak check). */
  get openClientSockets(): number { return [...this.listeners.keys()].filter((k) => this.clientKeys.has(k)).length; }
  private readonly clientKeys = new Set<string>();

  createSocketFactory(clientAddress: string): SocketFactory {
    return (handlers: SocketHandlers): KnxDatagramSocket => {
      const port = this.nextPort++;
      const self: RemoteInfo = { address: clientAddress, port };
      const k = key(self);
      let closed = false;
      this.listeners.set(k, (data, from) => { if (!closed) handlers.onMessage(data, from); });
      this.clientKeys.add(k);
      return {
        localPort: port,
        send: (data, toPort, toAddress) => { if (!closed) this.route(self, { address: toAddress, port: toPort }, Buffer.from(data)); },
        close: () => { closed = true; this.listeners.delete(k); this.clientKeys.delete(k); },
      };
    };
  }

  private route(from: RemoteInfo, to: RemoteInfo, original: Buffer): void {
    this.stats.sent++;
    let data = original;
    let copies = 1;
    let extraDelay = 0;
    const service = data.length >= 6 && data[0] === 0x06 ? data.readUInt16BE(2) : null;
    for (const r of this.rules) {
      if (r.remaining <= 0 || !r.match({ from, to, data, service })) continue;
      r.remaining--;
      if (r.action === "drop") { this.stats.dropped++; return; }
      if (r.action === "duplicate") { copies = 2; this.stats.duplicated++; }
      if (r.action === "corrupt") { data = (r.corrupt ?? defaultCorrupt)(Buffer.from(data)); this.stats.corrupted++; }
      if (r.action === "delay") { extraDelay += r.delayMs ?? 0; this.stats.delayed++; }
      break; // first matching rule wins
    }
    for (let i = 0; i < copies; i++) {
      const payload = Buffer.from(data);
      this.clock.setTimeout(() => {
        const h = this.listeners.get(key(to));
        if (!h) { this.stats.noRoute++; return; }
        this.stats.delivered++;
        h(payload, from);
      }, this.latencyMs + extraDelay);
    }
  }
}

function defaultCorrupt(b: Buffer): Buffer {
  if (b.length > 7) b[b.length - 1] = b[b.length - 1]! ^ 0xff;
  return b;
}
