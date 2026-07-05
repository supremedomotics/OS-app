import { InProcessEventBus, type IEventBus } from "./event-bus.js";
import { NatsEventBus } from "./nats-bus.js";
import { InMemoryPresenceStore, RedisPresenceStore, type IPresenceStore } from "./presence.js";

/**
 * Pick the messaging backends from the hub environment. Empty URLs → the in-process
 * defaults (dev/tests). A NATS/Redis URL → the real, cross-process backends. This is
 * the only place that decides; callers receive ready seams (§5, §14).
 */
export interface MessagingConfig {
  /** NATS server URL (e.g. "nats://nats:4222"); empty = in-process bus. */
  natsUrl?: string;
  /** Redis URL (e.g. "redis://redis:6379"); empty = in-process presence. */
  redisUrl?: string;
}

export async function createEventBus(config: MessagingConfig): Promise<IEventBus> {
  if (config.natsUrl) return NatsEventBus.connect({ url: config.natsUrl });
  return new InProcessEventBus();
}

export async function createPresenceStore(config: MessagingConfig): Promise<IPresenceStore> {
  if (config.redisUrl) return RedisPresenceStore.connect({ url: config.redisUrl });
  return new InMemoryPresenceStore();
}
