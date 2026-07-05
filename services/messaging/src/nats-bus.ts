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
interface NatsModule {
  connect(opts: { servers: string }): Promise<NatsConnection>;
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
    const nc = await nats.connect({ servers: opts.url });
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
