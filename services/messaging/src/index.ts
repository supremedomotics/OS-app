/**
 * @supreme/messaging — the hub's event bus + ephemeral/presence seams (§5, §14).
 *
 * Default implementations are in-process (dev/tests, single gateway). Production
 * swaps in NATS (event fan-out across processes) and Redis (shared presence) via the
 * factory, with zero change to callers.
 */
export {
  type IEventBus,
  type Subscription,
  InProcessEventBus,
  subjectMatches,
  subjects,
} from "./event-bus.js";
export { NatsEventBus, type NatsEventBusOptions } from "./nats-bus.js";
export {
  type IPresenceStore,
  InMemoryPresenceStore,
  RedisPresenceStore,
  type RedisPresenceOptions,
} from "./presence.js";
export {
  type MessagingConfig,
  createEventBus,
  createPresenceStore,
} from "./factory.js";
