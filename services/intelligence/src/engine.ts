/**
 * The Supreme Intelligence Engine core: a registry that runs independent intelligence MODULES and
 * merges their output. This is the extensibility seam — Presence, Energy, Comfort, Security,
 * Maintenance, Predictive, Occupancy, Wellness and the AI Assistant are each just an
 * `IntelligenceModule`; adding one is `engine.register(new XModule())` with ZERO changes here.
 *
 * Modules are pure evaluators: given a snapshot of the world (`EngineInput`) they return
 * Observations (facts they perceived) and Suggestions (proposed actions, each with a multi-dimension
 * Confidence). The engine never controls devices itself and never calls the cloud — the host
 * (gateway runner) decides what to do with suggestions under the user's Auto Pilot mode. A module
 * that throws is isolated: its failure is captured and the others still run.
 */
import type { Confidence } from "./confidence.js";

/** The action set offered on a suggestion notification (mirrors the product spec exactly). */
export type SuggestionAction = "turn_off" | "keep_on" | "ignore_today" | "always_ignore" | "enable_auto_pilot";

export interface Observation {
  /** Module that produced this (e.g. "presence"). */
  module: string;
  /** Free-form observation kind (e.g. "user_location", "device_idle"). */
  kind: string;
  /** What the observation is about — a userId, deviceId, roomId or zoneId. */
  subject: string;
  data: Record<string, unknown>;
  /** 0..1 certainty in this single observation. */
  confidence: number;
  ts: number;
}

export interface Suggestion {
  /** Stable key for de-duplication across ticks (e.g. `energy:idle:<deviceId>`). */
  key: string;
  module: string;
  kind: string;
  title: string;
  body: string;
  deviceId?: string;
  roomId?: string;
  zoneId?: string;
  ownerUserId?: string;
  actions: SuggestionAction[];
  confidence: Confidence;
  /** Estimated impact, surfaced in the notification + learning store. */
  estimatedWatts?: number;
  estimatedCostToday?: number;
  currency?: string;
  ts: number;
  metadata?: Record<string, unknown>;
}

export interface ModuleResult {
  observations: Observation[];
  suggestions: Suggestion[];
}

/** A snapshot of the world handed to every module; modules read what they need and ignore the rest. */
export interface EngineInput {
  homeId: string;
  now: number;
  [key: string]: unknown;
}

export interface IntelligenceModule {
  /** Stable id, also used to namespace its config + suggestions (e.g. "presence", "energy"). */
  readonly id: string;
  readonly title: string;
  evaluate(input: EngineInput): Promise<ModuleResult> | ModuleResult;
}

export interface EngineEvaluation extends ModuleResult {
  /** Per-module failures (id → message), so the host can surface degraded modules without crashing. */
  errors: Record<string, string>;
}

const EMPTY: ModuleResult = { observations: [], suggestions: [] };

export class IntelligenceEngine {
  private readonly modules = new Map<string, IntelligenceModule>();

  constructor(private readonly opts: { log?: (msg: string, meta?: Record<string, unknown>) => void } = {}) {}

  /** Register (or replace) a module by id. Returns this for chaining. */
  register(module: IntelligenceModule): this {
    this.modules.set(module.id, module);
    return this;
  }

  unregister(id: string): boolean {
    return this.modules.delete(id);
  }

  list(): IntelligenceModule[] {
    return [...this.modules.values()];
  }

  has(id: string): boolean {
    return this.modules.has(id);
  }

  /** Run every registered module against the snapshot and merge results. Failures are isolated. */
  async evaluate(input: EngineInput): Promise<EngineEvaluation> {
    const observations: Observation[] = [];
    const suggestions: Suggestion[] = [];
    const errors: Record<string, string> = {};
    // Run modules concurrently; one slow/failing module can't stall or break the others.
    const results = await Promise.all(
      this.list().map(async (m) => {
        try {
          return { id: m.id, result: (await m.evaluate(input)) ?? EMPTY };
        } catch (err) {
          const message = (err as Error).message;
          this.opts.log?.("intelligence module failed", { module: m.id, error: message });
          return { id: m.id, error: message };
        }
      }),
    );
    for (const r of results) {
      if ("error" in r && r.error !== undefined) {
        errors[r.id] = r.error;
        continue;
      }
      if ("result" in r && r.result) {
        observations.push(...r.result.observations);
        suggestions.push(...r.result.suggestions);
      }
    }
    return { observations, suggestions, errors };
  }
}
