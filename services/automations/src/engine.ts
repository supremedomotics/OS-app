import type {
  Automation,
  AutomationAction,
  AutomationCondition,
  AutomationTrigger,
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  Comparator,
  DeviceId,
  NotificationLevel,
  SceneId,
  ScheduleWindow,
  UserId,
} from "@supreme/domain-model";

/**
 * Native Supreme automation engine (§10) — executes the engine-agnostic DSL on the
 * hub, with zero HA involvement. Triggers are driven by SIL state events
 * (`onDeviceState`) and a once-per-minute clock (`tick`); the engine is otherwise
 * pure and deterministic, so it is fully unit-testable. Side effects go through
 * injected executors, which the gateway wires to the SIL, scenes, and notifications.
 */
export interface AutomationExecutors {
  command(deviceId: DeviceId, command: CapabilityCommand): Promise<void>;
  activateScene(sceneId: SceneId): Promise<void>;
  notify(input: {
    level: NotificationLevel;
    title: string;
    body: string;
    userId: UserId | null;
  }): Promise<void>;
  /** Read current state for condition evaluation. */
  getState(deviceId: DeviceId, capability: CapabilityKind): Promise<CapabilityState | null>;
}

export interface DeviceStateEvent {
  deviceId: DeviceId;
  capability: CapabilityKind;
  state: CapabilityState;
}

export interface EngineOptions {
  executors: AutomationExecutors;
  /** Injectable sleep (tests pass a no-op); defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Called whenever an automation runs (for audit/last-run tracking). */
  onRun?: (automationId: string, ok: boolean) => void;
}

export class AutomationEngine {
  private automations: Automation[] = [];
  private readonly ex: AutomationExecutors;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRun?: (id: string, ok: boolean) => void;
  /** Dedupe keys for time/interval triggers: automationId#index -> last fire ms. */
  private readonly lastFired = new Map<string, number>();

  constructor(opts: EngineOptions) {
    this.ex = opts.executors;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onRun = opts.onRun;
  }

  setAutomations(list: Automation[]): void {
    // Only the native engine executes; engine="ha" automations are compiled and
    // run by HA, so the native engine ignores them.
    this.automations = list.filter((a) => a.enabled && a.engine === "supreme");
  }

  /** Evaluate device_state triggers against an incoming SIL state delta. */
  async onDeviceState(event: DeviceStateEvent): Promise<void> {
    for (const a of this.automations) {
      const fired = a.triggers.some(
        (t) =>
          t.type === "device_state" &&
          t.deviceId === event.deviceId &&
          t.capability === event.capability &&
          compare(readField(event.state, t.field), t.op, t.value),
      );
      if (fired) await this.maybeRun(a);
    }
  }

  /** Evaluate time/interval triggers. Call once per minute in production. */
  async tick(now: Date = new Date()): Promise<void> {
    const minute = Math.floor(now.getTime() / 60_000);
    for (const a of this.automations) {
      for (let i = 0; i < a.triggers.length; i++) {
        const t = a.triggers[i]!;
        if (await this.timeTriggerFires(a.id, i, t, now, minute)) {
          await this.maybeRun(a);
          break; // one fire per automation per tick
        }
      }
    }
  }

  /** Run an automation's actions immediately (manual "test run"). */
  async run(automation: Automation): Promise<void> {
    await this.runActions(automation);
  }

  private async timeTriggerFires(
    automationId: string,
    index: number,
    t: AutomationTrigger,
    now: Date,
    minute: number,
  ): Promise<boolean> {
    const key = `${automationId}#${index}`;
    if (t.type === "time") {
      const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const dayOk = t.days.length === 0 || t.days.includes(now.getDay());
      if (hhmm === t.at && dayOk && this.lastFired.get(key) !== minute) {
        this.lastFired.set(key, minute);
        return true;
      }
    } else if (t.type === "interval") {
      const last = this.lastFired.get(key);
      if (last === undefined || minute - last >= t.everyMinutes) {
        this.lastFired.set(key, minute);
        return true;
      }
    }
    return false;
  }

  private async maybeRun(a: Automation): Promise<void> {
    if (await this.conditionsPass(a.conditions, new Date())) {
      await this.runActions(a);
    }
  }

  private async conditionsPass(conditions: AutomationCondition[], now: Date): Promise<boolean> {
    for (const c of conditions) {
      if (c.type === "device_state") {
        const state = await this.ex.getState(c.deviceId, c.capability);
        if (!state || !compare(readField(state, c.field), c.op, c.value)) return false;
      } else if (c.type === "time_window") {
        if (!inWindow(c.window, now)) return false;
      }
    }
    return true;
  }

  private async runActions(a: Automation): Promise<void> {
    try {
      for (const action of a.actions) await this.runAction(action);
      this.onRun?.(a.id, true);
    } catch {
      this.onRun?.(a.id, false);
    }
  }

  private async runAction(action: AutomationAction): Promise<void> {
    switch (action.type) {
      case "device_command":
        await this.ex.command(action.deviceId, action.command);
        return;
      case "scene_activate":
        await this.ex.activateScene(action.sceneId);
        return;
      case "notify":
        await this.ex.notify({
          level: action.level,
          title: action.title,
          body: action.body,
          userId: action.userId,
        });
        return;
      case "delay":
        await this.sleep(action.ms);
        return;
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function readField(state: CapabilityState, field: string): unknown {
  return (state as unknown as Record<string, unknown>)[field];
}

function compare(actual: unknown, op: Comparator, value: unknown): boolean {
  switch (op) {
    case "changed":
      return true;
    case "eq":
      return actual === value;
    case "ne":
      return actual !== value;
    case "gt":
      return Number(actual) > Number(value);
    case "lt":
      return Number(actual) < Number(value);
    case "gte":
      return Number(actual) >= Number(value);
    case "lte":
      return Number(actual) <= Number(value);
  }
}

function inWindow(w: ScheduleWindow, now: Date): boolean {
  if (!w.days.includes(now.getDay())) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= toMin(w.start) && mins < toMin(w.end);
}
function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
