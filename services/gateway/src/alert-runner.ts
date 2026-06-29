/**
 * Duration-based alert rules (§13) — peace-of-mind notifications: "tell me if the front door is left
 * OPEN / UNLOCKED, or a light left ON, for more than N minutes". The condition check is pure; the
 * runner tracks how long each rule has held true and fires a notification ONCE per episode (when the
 * duration is first exceeded), resetting when the condition clears. Rules come from the durable
 * config store; missing → nothing fires.
 */

export type AlertRuleType = "left_on" | "left_open" | "left_unlocked";

export interface AlertRule {
  id: string;
  deviceId: string;
  type: AlertRuleType;
  durationMinutes: number;
  message?: string;
}

export class AlertRuleError extends Error {}

/** Validate a rule on write. */
export function validateAlertRule(r: unknown): AlertRule {
  const o = r as Partial<AlertRule>;
  if (!o || typeof o.deviceId !== "string" || !o.deviceId) throw new AlertRuleError("rule needs a deviceId");
  if (o.type !== "left_on" && o.type !== "left_open" && o.type !== "left_unlocked") throw new AlertRuleError("rule type must be left_on|left_open|left_unlocked");
  if (typeof o.durationMinutes !== "number" || o.durationMinutes <= 0 || o.durationMinutes > 1440) throw new AlertRuleError("durationMinutes must be 1..1440");
  return {
    id: typeof o.id === "string" && o.id ? o.id : `alert_${o.deviceId}_${o.type}`,
    deviceId: o.deviceId,
    type: o.type,
    durationMinutes: o.durationMinutes,
    ...(o.message ? { message: o.message } : {}),
  };
}

/** Whether a rule's alerting condition currently holds, given the device's capability state map. */
export function alertConditionMet(type: AlertRuleType, state: Record<string, unknown> | undefined): boolean {
  if (!state) return false;
  switch (type) {
    case "left_on":
      return (state.onoff as { on?: boolean } | undefined)?.on === true;
    case "left_open":
      return ((state.position as { position?: number } | undefined)?.position ?? 0) > 0;
    case "left_unlocked":
      return (state.lock as { locked?: boolean } | undefined)?.locked === false;
  }
}

const defaultMessage = (type: AlertRuleType, name: string): string => {
  switch (type) {
    case "left_on":
      return `${name} has been left on`;
    case "left_open":
      return `${name} has been left open`;
    case "left_unlocked":
      return `${name} has been left unlocked`;
  }
};

interface Episode {
  since: number | null;
  fired: boolean;
}

export class AlertRuleRunner {
  private readonly episodes = new Map<string, Episode>();
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      getRules: () => Promise<AlertRule[]>;
      getDevice: (deviceId: string) => Promise<{ name: string; state?: Record<string, unknown> } | null>;
      notify: (message: string) => Promise<void>;
      now?: () => number;
      log?: (msg: string, meta?: Record<string, unknown>) => void;
    },
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  async tick(): Promise<void> {
    const rules = await this.opts.getRules();
    const t = this.now();
    // Drop episode state for rules that no longer exist (keeps the map bounded by current rules).
    const live = new Set(rules.map((r) => r.id));
    for (const id of this.episodes.keys()) if (!live.has(id)) this.episodes.delete(id);
    for (const rule of rules) {
      const device = await this.opts.getDevice(rule.deviceId);
      const met = alertConditionMet(rule.type, device?.state);
      const ep = this.episodes.get(rule.id) ?? { since: null, fired: false };
      if (!met) {
        this.episodes.set(rule.id, { since: null, fired: false }); // condition cleared → reset
        continue;
      }
      if (ep.since === null) ep.since = t;
      if (!ep.fired && t - ep.since >= rule.durationMinutes * 60_000) {
        ep.fired = true;
        try {
          await this.opts.notify(rule.message ?? defaultMessage(rule.type, device?.name ?? "A device"));
          this.opts.log?.("alert rule fired", { ruleId: rule.id });
        } catch (err) {
          this.opts.log?.("alert notify failed", { ruleId: rule.id, error: (err as Error).message });
        }
      }
      this.episodes.set(rule.id, ep);
    }
  }
}
