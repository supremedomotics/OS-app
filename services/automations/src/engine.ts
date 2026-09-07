import type {
  Automation,
  AutomationAction,
  AutomationCondition,
  AutomationTrigger,
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
  IntentTarget,
  NotificationLevel,
  SceneId,
  UserId,
} from "@supreme/domain-model";
import { evaluateComparator, isWithinScheduleWindow, readCapabilityField } from "@supreme/domain-model";

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
  /** § Universal Intent & Capability Engine (Phase 2) — run an `"intent"` action.
   * Optional: an executor set built before the Intent Engine existed (or a test
   * fixture that never exercises an `"intent"` action) simply omits it; a
   * DSL that DOES contain one throws a clear, honest error at execution time
   * rather than silently no-op'ing (see `runAutomationAction`'s `"intent"` case). */
  runIntent?(intentId: string, target: IntentTarget, params: Record<string, unknown>): Promise<void>;
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
  /** How many recent execution records to retain per engine (Automation Debugger). */
  historyLimit?: number;
  /** Monotonic clock for durations (tests can inject); defaults to Date.now. */
  now?: () => number;
}

/** One action's outcome within a run (§ Automation Debugger). */
export interface AutomationRunAction {
  type: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  summary: string;
}

/** A single automation execution trace — the unit the Automation Debugger renders. */
export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: string;
  /** What set it off: "device_state" | "time" | "interval" | "manual". */
  trigger: string;
  conditionsPassed: boolean;
  /** The first condition that failed (why it didn't run), when applicable. */
  failedCondition?: string;
  actions: AutomationRunAction[];
  durationMs: number;
  ok: boolean;
  error?: string;
}

export class AutomationEngine {
  private automations: Automation[] = [];
  private readonly ex: AutomationExecutors;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRun?: (id: string, ok: boolean) => void;
  /** Dedupe keys for time/interval triggers: automationId#index -> last fire ms. */
  private readonly lastFired = new Map<string, number>();
  /** Execution history ring buffer (newest last) for the Automation Debugger. */
  private readonly runs: AutomationRun[] = [];
  private readonly historyLimit: number;
  private readonly now: () => number;
  private runSeq = 0;

  constructor(opts: EngineOptions) {
    this.ex = opts.executors;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onRun = opts.onRun;
    this.historyLimit = opts.historyLimit ?? 100;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Recent execution traces, newest first (optionally for one automation). */
  recentRuns(automationId?: string, limit = 50): AutomationRun[] {
    const all = automationId ? this.runs.filter((r) => r.automationId === automationId) : this.runs;
    return all.slice(-limit).reverse();
  }

  setAutomations(list: Automation[]): void {
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
          evaluateComparator(readCapabilityField(event.state, t.field), t.op, t.value),
      );
      if (fired) await this.execute(a, "device_state");
    }
  }

  /** Evaluate time/interval triggers. Call once per minute in production. */
  async tick(now: Date = new Date()): Promise<void> {
    const minute = Math.floor(now.getTime() / 60_000);
    for (const a of this.automations) {
      for (let i = 0; i < a.triggers.length; i++) {
        const t = a.triggers[i]!;
        if (await this.timeTriggerFires(a.id, i, t, now, minute)) {
          await this.execute(a, t.type);
          break; // one fire per automation per tick
        }
      }
    }
  }

  /** Run an automation's actions immediately (manual "test run"; conditions are skipped). */
  async run(automation: Automation): Promise<void> {
    await this.execute(automation, "manual", true);
  }

  /**
   * Best-effort concurrent run (§ ADR 0101 Part 1 — Scene Runtime): the SAME `runAction`/
   * `record` primitives as {@link run}, just aggregated differently — every action is attempted
   * regardless of a sibling's failure, instead of stopping at the first one. Scenes need this
   * (a scene with 12 steps where one light is offline should still apply the other 11), which
   * `execute()`'s stop-on-first-failure trace intentionally does NOT provide for ordinary
   * automations. This is not a second engine: same executors, same action dispatch, same run
   * history ring buffer, same `onRun` last-run hook — only the aggregation strategy differs.
   */
  async runConcurrent(automation: Automation, trigger = "manual"): Promise<AutomationRun> {
    const started = new Date();
    const t0 = this.now();
    const actions: AutomationRunAction[] = await Promise.all(
      automation.actions.map(async (action): Promise<AutomationRunAction> => {
        const a0 = this.now();
        try {
          await this.runAction(action);
          return { type: action.type, ok: true, durationMs: this.now() - a0, summary: describeAutomationAction(action) };
        } catch (e) {
          return { type: action.type, ok: false, error: e instanceof Error ? e.message : String(e), durationMs: this.now() - a0, summary: describeAutomationAction(action) };
        }
      }),
    );
    const run: AutomationRun = {
      id: `run-${started.getTime()}-${this.runSeq++}`,
      automationId: automation.id,
      startedAt: started.toISOString(),
      trigger,
      conditionsPassed: true,
      actions,
      durationMs: this.now() - t0,
      ok: actions.every((a) => a.ok),
    };
    this.record(run);
    return run;
  }

  /**
   * Dry-run (§ Phase 1 — Testing without touching real devices): evaluates the SAME conditions
   * a real run would, against REAL current state (`this.ex.getState`), but never calls
   * `runAction` — every action is recorded as "would execute" with no side effect and no
   * device command. Recorded into the SAME run history as a real run (trigger `"dry_run"`) so
   * the Automation Debugger shows it identically, just clearly labeled.
   */
  async dryRun(automation: Automation): Promise<AutomationRun> {
    const started = new Date();
    const t0 = this.now();
    const { passed: conditionsPassed, failed: failedCondition } = await this.evaluateConditions(automation.conditions, started);

    const actions: AutomationRunAction[] = conditionsPassed
      ? automation.actions.map((action) => ({ type: action.type, ok: true, durationMs: 0, summary: `Would run: ${describeAutomationAction(action)}` }))
      : [];

    const run: AutomationRun = {
      id: `dryrun-${started.getTime()}-${this.runSeq++}`,
      automationId: automation.id,
      startedAt: started.toISOString(),
      trigger: "dry_run",
      conditionsPassed,
      ...(failedCondition ? { failedCondition } : {}),
      actions,
      durationMs: this.now() - t0,
      ok: conditionsPassed,
    };
    this.runs.push(run);
    if (this.runs.length > this.historyLimit) this.runs.shift();
    return run;
  }

  /**
   * Health (§ Phase 1): a plain-language-explainable status derived ENTIRELY from existing,
   * already-recorded run history + the automation's own enabled flag — no new tracked state.
   */
  health(automation: Automation): { status: "disabled" | "waiting" | "healthy" | "warning" | "broken"; reason: string } {
    if (!automation.enabled) return { status: "disabled", reason: "Automation is turned off." };
    // § Native Backend Implementation — Home Assistant has been fully removed, so the
    // "engine" schema no longer even accepts "ha" for new/updated rows. A legacy
    // persisted row from before that removal could still carry it on disk, though (the
    // schema change doesn't retroactively rewrite the database) — this must never look
    // silently "healthy"/"waiting" while it in fact never runs; see setAutomations()
    // below. Compared as a plain string since the type itself no longer includes "ha".
    if ((automation.engine as string) === "ha") {
      return {
        status: "broken",
        reason: "This automation targets Home Assistant execution, which is not supported on this hub — it will never run. Recreate it using the native engine.",
      };
    }
    // Dry-runs are synthetic (§ Phase 1 — never a real side effect) and share the same history
    // ring buffer as real runs purely so the debugger can show them inline; Health must reflect
    // only REAL executions, or a passing dry-run could mask (or a "would fail" dry-run could
    // falsely report) the automation's actual operational status.
    const runs = this.recentRuns(automation.id, 20).filter((r) => r.trigger !== "dry_run").slice(0, 5);
    if (runs.length === 0) return { status: "waiting", reason: "Enabled — hasn't triggered yet." };
    const last = runs[0]!;
    if (!last.ok && last.conditionsPassed) {
      const recentFailures = runs.filter((r) => r.conditionsPassed && !r.ok).length;
      if (recentFailures >= runs.length) return { status: "broken", reason: `Last ${recentFailures} run(s) failed: ${last.error ?? "an action failed"}.` };
      return { status: "warning", reason: `Last run failed: ${last.error ?? "an action failed"}.` };
    }
    return { status: "healthy", reason: last.conditionsPassed ? "Last run completed successfully." : "Waiting — conditions weren't met last time." };
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

  /**
   * Execute an automation with a full trace (§ Automation Debugger): evaluate conditions (capturing
   * the first failure), run actions capturing each one's outcome + duration, and record the run.
   */
  private async execute(a: Automation, trigger: string, skipConditions = false): Promise<void> {
    const started = new Date();
    const t0 = this.now();
    let conditionsPassed = true;
    let failedCondition: string | undefined;
    if (!skipConditions) {
      const res = await this.evaluateConditions(a.conditions, started);
      conditionsPassed = res.passed;
      failedCondition = res.failed;
    }

    const actions: AutomationRunAction[] = [];
    let ok = true;
    let error: string | undefined;
    if (conditionsPassed) {
      for (const action of a.actions) {
        const a0 = this.now();
        try {
          await this.runAction(action);
          actions.push({ type: action.type, ok: true, durationMs: this.now() - a0, summary: describeAutomationAction(action) });
        } catch (e) {
          ok = false;
          error = e instanceof Error ? e.message : String(e);
          actions.push({ type: action.type, ok: false, error, durationMs: this.now() - a0, summary: describeAutomationAction(action) });
          break; // stop the run on the first failing action (as before)
        }
      }
    }

    this.record({
      id: `run-${started.getTime()}-${this.runSeq++}`,
      automationId: a.id,
      startedAt: started.toISOString(),
      trigger,
      conditionsPassed,
      ...(failedCondition ? { failedCondition } : {}),
      actions,
      durationMs: this.now() - t0,
      ok: conditionsPassed && ok,
      ...(error ? { error } : {}),
    });
  }

  private record(run: AutomationRun): void {
    this.runs.push(run);
    if (this.runs.length > this.historyLimit) this.runs.shift();
    // A run only counts as "ran" (for last-run tracking) when its conditions passed.
    if (run.conditionsPassed) this.onRun?.(run.automationId, run.ok);
  }

  private async evaluateConditions(
    conditions: AutomationCondition[],
    now: Date,
  ): Promise<{ passed: boolean; failed?: string }> {
    for (const c of conditions) {
      if (c.type === "device_state") {
        const state = await this.ex.getState(c.deviceId, c.capability);
        if (!state || !evaluateComparator(readCapabilityField(state, c.field), c.op, c.value)) {
          return { passed: false, failed: `${c.capability}.${c.field} ${c.op} ${JSON.stringify(c.value)} on ${c.deviceId}` };
        }
      } else if (c.type === "time_window") {
        if (!isWithinScheduleWindow(c.window, now)) return { passed: false, failed: `outside window ${c.window.start}–${c.window.end}` };
      }
    }
    return { passed: true };
  }

  private async runAction(action: AutomationAction): Promise<void> {
    await runAutomationAction(action, this.ex, this.sleep);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Execute one {@link AutomationAction} against a set of executors — extracted so
 * `@supreme/keypad-framework`'s Mapping Engine (§ Universal Keypad Framework) can run
 * the exact same reused `AutomationAction` union without re-implementing this
 * dispatch (a keypad mapping's actions ARE automation actions, by design — see
 * `KeypadMapping` in `@supreme/domain-model`).
 */
export async function runAutomationAction(
  action: AutomationAction,
  ex: AutomationExecutors,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  switch (action.type) {
    case "device_command":
      await ex.command(action.deviceId, action.command);
      return;
    case "scene_activate":
      await ex.activateScene(action.sceneId);
      return;
    case "notify":
      await ex.notify({
        level: action.level,
        title: action.title,
        body: action.body,
        userId: action.userId,
      });
      return;
    case "delay":
      await sleep(action.ms);
      return;
    case "intent":
      if (!ex.runIntent) {
        throw new Error(
          `intent action "${action.intentId}" requires a wired Intent Engine — this executor set does not support runIntent`,
        );
      }
      await ex.runIntent(action.intentId, action.target, action.params);
      return;
  }
}

/** A short human summary of an action for the debugger timeline — also reused by the
 * Mapping Engine's own run traces. */
export function describeAutomationAction(action: AutomationAction): string {
  switch (action.type) {
    case "device_command":
      return `Command ${action.command.capability} → ${action.deviceId}`;
    case "scene_activate":
      return `Activate scene ${action.sceneId}`;
    case "notify":
      return `Notify "${action.title}"`;
    case "delay":
      return `Delay ${action.ms}ms`;
    case "intent":
      return `Intent ${action.intentId} → ${describeIntentTarget(action.target)}`;
  }
}

function describeIntentTarget(target: IntentTarget): string {
  switch (target.kind) {
    case "device":
      return target.deviceId;
    case "room":
      return `room ${target.roomId}`;
    case "scene":
      return `scene ${target.sceneId}`;
    case "automation":
      return `automation ${target.automationId}`;
    case "home":
      return "home";
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
