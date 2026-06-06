/**
 * Event bus seam (§2.1, §5, §14). The hub's normalized device events + notification
 * stream flow over this so the gateway can scale to multiple processes: the SIL-owning
 * process publishes, every process subscribes and fans out to its own WSS clients.
 *
 * Default = {@link InProcessEventBus} (synchronous, single-process — what dev and the
 * test suite use; identical observable behavior to the old direct fan-out). Production
 * swaps in the NATS-backed bus (see nats-bus.ts) with no caller change.
 *
 * Subjects use NATS token semantics (`.`-delimited; `*` = one token; `>` = tail).
 */
export interface Subscription {
  unsubscribe(): void;
}

export interface IEventBus {
  /** Publish a JSON-serializable payload to a concrete subject. */
  publish<T>(subject: string, payload: T): Promise<void>;
  /** Subscribe to a subject pattern; the handler runs for each matching message. */
  subscribe<T>(
    pattern: string,
    handler: (payload: T, subject: string) => void,
  ): Promise<Subscription>;
  close(): Promise<void>;
}

/** NATS-style subject match: `*` matches one token, `>` matches one-or-more trailing. */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    const tok = p[i];
    if (tok === ">") return s.length >= i + 1;
    if (i >= s.length) return false;
    if (tok !== "*" && tok !== s[i]) return false;
  }
  return p.length === s.length;
}

/**
 * In-process bus: publish synchronously invokes every matching subscriber. Used by
 * dev and tests; a single gateway process behaves exactly as the prior direct
 * fan-out, so no test had to change.
 */
export class InProcessEventBus implements IEventBus {
  private readonly subs = new Set<{ pattern: string; handler: (p: unknown, subject: string) => void }>();

  async publish<T>(subject: string, payload: T): Promise<void> {
    // Round-trip through JSON so callers can't accidentally rely on shared references
    // (the NATS bus serializes too — keeps the two implementations observably equal).
    const wire = JSON.parse(JSON.stringify(payload)) as unknown;
    for (const sub of this.subs) {
      if (subjectMatches(sub.pattern, subject)) sub.handler(wire, subject);
    }
  }

  async subscribe<T>(
    pattern: string,
    handler: (payload: T, subject: string) => void,
  ): Promise<Subscription> {
    const entry = { pattern, handler: handler as (p: unknown, subject: string) => void };
    this.subs.add(entry);
    return { unsubscribe: () => this.subs.delete(entry) };
  }

  async close(): Promise<void> {
    this.subs.clear();
  }
}

/** Canonical subjects (single-hub = single home; home id keeps it multi-home-ready). */
export const subjects = {
  deviceState: (homeId: string): string => `supreme.home.${homeId}.device.state`,
  notification: (homeId: string): string => `supreme.home.${homeId}.notification`,
} as const;
