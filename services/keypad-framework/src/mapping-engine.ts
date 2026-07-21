import type { AutomationExecutors } from "@supreme/automations";
import { describeAutomationAction, runAutomationAction } from "@supreme/automations";
import type { AutomationCondition, KeypadInputEvent, KeypadMapping } from "@supreme/domain-model";
import { evaluateComparator, isWithinScheduleWindow, readCapabilityField } from "@supreme/domain-model";

/**
 * Mapping Engine (§ Universal Keypad Framework, deliverable 8 — backend only, no
 * editor yet). Mirrors `@supreme/automations`' `AutomationEngine` deliberately: same
 * executors contract, same run-trace shape, same condition-evaluation semantics
 * (reused verbatim from `@supreme/domain-model`'s `condition-eval.ts`) — a keypad
 * mapping fires on a `KeypadInputEvent` instead of a device-state delta/clock tick,
 * but everything downstream of "should this fire" is the exact same Supreme
 * capability-command vocabulary the Automation Engine already executes. The
 * Automation Engine itself is untouched; this is a new, parallel executor for a
 * different trigger source, not a fork of its internals.
 */

export interface KeypadMappingRunAction {
  type: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  summary: string;
}

/** A single mapping execution trace — same shape as `AutomationRun`, for parity
 * with the Automation Debugger's UI/mental model. */
export interface KeypadMappingRun {
  id: string;
  mappingId: string;
  startedAt: string;
  conditionsPassed: boolean;
  failedCondition?: string;
  actions: KeypadMappingRunAction[];
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface KeypadMappingEngineOptions {
  executors: AutomationExecutors;
  /** Injectable sleep for `"delay"` actions (tests pass a no-op); defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Called whenever a mapping runs (for audit/last-run tracking). */
  onRun?: (mappingId: string, ok: boolean) => void;
  /** How many recent execution records to retain (mirrors the Automation Debugger). */
  historyLimit?: number;
  /** Monotonic clock for durations (tests can inject); defaults to Date.now. */
  now?: () => number;
}

export class KeypadMappingEngine {
  private mappings: KeypadMapping[] = [];
  private readonly ex: AutomationExecutors;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRun?: (id: string, ok: boolean) => void;
  private readonly runs: KeypadMappingRun[] = [];
  private readonly historyLimit: number;
  private readonly now: () => number;
  private runSeq = 0;

  constructor(opts: KeypadMappingEngineOptions) {
    this.ex = opts.executors;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onRun = opts.onRun;
    this.historyLimit = opts.historyLimit ?? 100;
    this.now = opts.now ?? (() => Date.now());
  }

  recentRuns(mappingId?: string, limit = 50): KeypadMappingRun[] {
    const all = mappingId ? this.runs.filter((r) => r.mappingId === mappingId) : this.runs;
    return all.slice(-limit).reverse();
  }

  setMappings(list: KeypadMapping[]): void {
    this.mappings = list.filter((m) => m.enabled);
  }

  /** Fire every mapping whose (keypad, control, event type) matches this input. */
  async onInputEvent(event: KeypadInputEvent): Promise<void> {
    for (const m of this.mappings) {
      if (m.input.keypadId === event.keypadId && m.input.control === event.control && m.input.event === event.type) {
        await this.execute(m);
      }
    }
  }

  /** Run a mapping's actions immediately (manual "test run"; conditions are skipped). */
  async run(mapping: KeypadMapping): Promise<void> {
    await this.execute(mapping, true);
  }

  private async execute(m: KeypadMapping, skipConditions = false): Promise<void> {
    const started = new Date();
    const t0 = this.now();
    let conditionsPassed = true;
    let failedCondition: string | undefined;
    if (!skipConditions) {
      const res = await this.evaluateConditions(m.conditions, started);
      conditionsPassed = res.passed;
      failedCondition = res.failed;
    }

    const actions: KeypadMappingRunAction[] = [];
    let ok = true;
    let error: string | undefined;
    if (conditionsPassed) {
      // m.actions are already concrete, validated AutomationActions — any "{{name}}"
      // reference into m.variables was resolved once, at mapping create/update time
      // (see `expandVariables` in variables.ts), never re-resolved per firing.
      for (const action of m.actions) {
        const a0 = this.now();
        try {
          await runAutomationAction(action, this.ex, this.sleep);
          actions.push({ type: action.type, ok: true, durationMs: this.now() - a0, summary: describeAutomationAction(action) });
        } catch (e) {
          ok = false;
          error = e instanceof Error ? e.message : String(e);
          actions.push({ type: action.type, ok: false, error, durationMs: this.now() - a0, summary: describeAutomationAction(action) });
          break; // stop the run on the first failing action, mirroring the Automation Engine
        }
      }
    }

    this.record({
      id: `kpr-${started.getTime()}-${this.runSeq++}`,
      mappingId: m.id,
      startedAt: started.toISOString(),
      conditionsPassed,
      ...(failedCondition ? { failedCondition } : {}),
      actions,
      durationMs: this.now() - t0,
      ok: conditionsPassed && ok,
      ...(error ? { error } : {}),
    });
  }

  private record(run: KeypadMappingRun): void {
    this.runs.push(run);
    if (this.runs.length > this.historyLimit) this.runs.shift();
    if (run.conditionsPassed) this.onRun?.(run.mappingId, run.ok);
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
}
