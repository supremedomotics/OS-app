import type { AutomationExecutors } from "@supreme/automations";
import { describeAutomationAction, runAutomationAction } from "@supreme/automations";
import type { AutomationAction, AutomationCondition, KeypadInputEvent, KeypadMapping, KeypadMappingBehaviorState, KeypadMappingId } from "@supreme/domain-model";
import { evaluateComparator, isWithinScheduleWindow, readCapabilityField } from "@supreme/domain-model";
import { resolveBehaviorCommand } from "./behavior.js";

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
  /** Called for every mapping matched by a real button-press/gesture event (never a manual
   * `testRun`), win or lose — lets a caller log "button X pressed → mapping Y triggered/not
   * triggered" regardless of outcome (see gateway `installer.logEvent("supreme-keypad", …)`). */
  onFire?: (event: KeypadInputEvent, mapping: KeypadMapping, run: KeypadMappingRun) => void;
  /** How many recent execution records to retain (mirrors the Automation Debugger). */
  historyLimit?: number;
  /** Monotonic clock for durations (tests can inject); defaults to Date.now. */
  now?: () => number;
  /** § Stage 2 — persist a behavior-driven mapping's updated `behaviorState` (the new
   * `lastDirection` after an "alternate" firing, the new `cycleIndex` after a "cycle"
   * firing) so it survives a restart. Called after a successful resolution, before the
   * resolved command is dispatched. Optional: an engine built without one (e.g. a test that
   * doesn't care about restart persistence) simply keeps the update in memory only — the
   * in-memory `this.mappings` entry is still updated either way, so back-to-back firings in
   * the SAME process always see the latest state regardless. */
  persistBehaviorState?: (mappingId: KeypadMappingId, behaviorState: KeypadMappingBehaviorState) => Promise<void>;
}

export class KeypadMappingEngine {
  private mappings: KeypadMapping[] = [];
  private readonly ex: AutomationExecutors;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRun?: (id: string, ok: boolean) => void;
  private readonly onFire?: (event: KeypadInputEvent, mapping: KeypadMapping, run: KeypadMappingRun) => void;
  private readonly runs: KeypadMappingRun[] = [];
  private readonly historyLimit: number;
  private readonly now: () => number;
  private readonly persistBehaviorState?: (mappingId: KeypadMappingId, behaviorState: KeypadMappingBehaviorState) => Promise<void>;
  private runSeq = 0;

  constructor(opts: KeypadMappingEngineOptions) {
    this.ex = opts.executors;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onRun = opts.onRun;
    this.onFire = opts.onFire;
    this.historyLimit = opts.historyLimit ?? 100;
    this.now = opts.now ?? (() => Date.now());
    this.persistBehaviorState = opts.persistBehaviorState;
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
        const run = await this.execute(m);
        this.onFire?.(event, m, run);
      }
    }
  }

  /** Run a mapping's actions immediately (manual "test run"; conditions are skipped). */
  async run(mapping: KeypadMapping): Promise<void> {
    await this.execute(mapping, true);
  }

  private async execute(m: KeypadMapping, skipConditions = false): Promise<KeypadMappingRun> {
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
      try {
        // § Stage 2 — a non-"direct" behavior resolves to a run of exactly ONE action
        // (toggle/alternate/increment/decrement: a single synthesized `device_command`;
        // cycle: one entry of `m.actions`, advanced by index), never "run everything in
        // `actions`" — that's `"direct"`'s job alone, unchanged from before Stage 2.
        const toRun = await this.resolveActionsToRun(m);
        for (const action of toRun) {
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
      } catch (e) {
        // Behavior resolution itself failed (e.g. an unsupported capability for "toggle") —
        // never silently swallowed; recorded as a run failure with zero actions attempted,
        // same as any other unrunnable mapping.
        ok = false;
        error = e instanceof Error ? e.message : String(e);
      }
    }

    const run: KeypadMappingRun = {
      id: `kpr-${started.getTime()}-${this.runSeq++}`,
      mappingId: m.id,
      startedAt: started.toISOString(),
      conditionsPassed,
      ...(failedCondition ? { failedCondition } : {}),
      actions,
      durationMs: this.now() - t0,
      ok: conditionsPassed && ok,
      ...(error ? { error } : {}),
    };
    this.record(run);
    return run;
  }

  /** § Stage 2 — turn one mapping firing into the concrete `AutomationAction[]` to actually
   * run, and persist any `behaviorState` change the resolution produced. */
  private async resolveActionsToRun(m: KeypadMapping): Promise<AutomationAction[]> {
    if (m.behavior === "direct") return m.actions;

    if (m.behavior === "cycle") {
      if (m.actions.length === 0) return [];
      const index = m.behaviorState.cycleIndex % m.actions.length;
      const action = m.actions[index]!;
      await this.applyBehaviorState(m, { ...m.behaviorState, cycleIndex: (index + 1) % m.actions.length });
      return [action];
    }

    const resolved = await resolveBehaviorCommand(this.ex, m);
    if (resolved.nextBehaviorState) await this.applyBehaviorState(m, resolved.nextBehaviorState);
    return [{ type: "device_command", deviceId: m.target!.deviceId, command: resolved.command }];
  }

  /** Update this mapping's `behaviorState` both in the engine's own in-memory copy (so the
   * VERY NEXT firing in this same process sees it immediately, with no store round-trip) and,
   * when a persistence hook was supplied, durably — so it survives a restart. Mutates the
   * `this.mappings` entry in place by replacing it, never the caller's own object. */
  private async applyBehaviorState(m: KeypadMapping, next: KeypadMappingBehaviorState): Promise<void> {
    m.behaviorState = next;
    const idx = this.mappings.findIndex((x) => x.id === m.id);
    if (idx >= 0) this.mappings[idx] = m;
    if (this.persistBehaviorState) await this.persistBehaviorState(m.id, next);
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
