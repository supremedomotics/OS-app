import type { IEventBus, Subscription } from "./event-bus.js";

/**
 * NATS-backed event bus (§5, §14). Connects to the hub's NATS server so device
 * state + notifications fan out across every gateway process. `nats` is an optional
 * dependency loaded dynamically — the package builds and the in-process default runs
 * without it; only the real multi-process path needs it installed (it ships in the
 * hub image). Core NATS pub/sub is used (at-most-once); the durable command/event
 * history that JetStream provides is a later concern (tracked in §5).
 */

// Minimal structural types for the slice of `nats` we use — avoids a hard build-time
// dependency on the package's types (it's dynamically imported).
interface NatsMsg {
  subject: string;
  data: Uint8Array;
}
interface NatsSubscription extends AsyncIterable<NatsMsg> {
  unsubscribe(): void;
}
interface NatsConnection {
  publish(subject: string, data: Uint8Array): void;
  subscribe(subject: string): NatsSubscription;
  drain(): Promise<void>;
}
interface NatsConnectOpts {
  servers: string;
  // § Native-linux NATS/Gateway readiness hardening — real production evidence: the
  // Gateway crashed with ECONNREFUSED 127.0.0.1:4222 and restart-looped under systemd
  // whenever it started before NATS was accepting connections (e.g. right after boot, or
  // mid-repair). `nats.connect()` by default only reconnects AFTER an established
  // connection later drops — the FIRST attempt just throws if nothing is listening yet.
  // `waitOnFirstConnect: true` is the nats.js client's own documented switch to apply its
  // existing reconnect/backoff logic to that first attempt too — reusing the client's
  // built-in mechanism instead of inventing a retry loop here. `maxReconnectAttempts: -1`
  // (infinite) + a bounded `reconnectTimeWait` backoff means a Gateway that starts before
  // NATS is ready — or loses it later, mid-run — keeps retrying quietly instead of
  // crashing the process (which is what fed the systemd restart storm).
  waitOnFirstConnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectTimeWait?: number;
}
interface NatsModule {
  connect(opts: NatsConnectOpts): Promise<NatsConnection>;
}

export interface NatsEventBusOptions {
  /** e.g. "nats://nats:4222". */
  url: string;
}

export class NatsEventBus implements IEventBus {
  private readonly enc = new TextEncoder();
  private readonly dec = new TextDecoder();
  private constructor(private readonly nc: NatsConnection) {}

  static async connect(opts: NatsEventBusOptions): Promise<NatsEventBus> {
    // Variable specifier so the bundler/tsc doesn't try to resolve `nats` at build.
    const moduleName = "nats";
    const nats = (await import(moduleName)) as unknown as NatsModule;
    const nc = await nats.connect({
      servers: opts.url,
      waitOnFirstConnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
    });
    return new NatsEventBus(nc);
  }

  async publish<T>(subject: string, payload: T): Promise<void> {
    this.nc.publish(subject, this.enc.encode(JSON.stringify(payload)));
  }

  async subscribe<T>(
    pattern: string,
    handler: (payload: T, subject: string) => void,
  ): Promise<Subscription> {
    const sub = this.nc.subscribe(pattern);
    void (async () => {
      for await (const msg of sub) {
        try {
          handler(JSON.parse(this.dec.decode(msg.data)) as T, msg.subject);
        } catch {
          // A malformed message must not tear down the subscription loop.
        }
      }
    })();
    return { unsubscribe: () => sub.unsubscribe() };
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}
