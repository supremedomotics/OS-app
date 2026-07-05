/**
 * Multi-dimensional confidence model (Supreme Intelligence Engine).
 *
 * Every intelligence decision carries a breakdown of WHY it's (un)certain, not a single opaque
 * number — so the UI can explain itself ("present 98%, room vacant 91%, ownership 100%") and Auto
 * Pilot can gate on a configurable threshold. Dimensions are open-ended (a map), so new modules add
 * their own (e.g. comfort, security) without changing this file. `decision` is the single rolled-up
 * score Auto Pilot acts on. All values are clamped to 0..1. Pure + deterministic.
 */

/** Canonical dimensions the first modules use; modules may add their own keys freely. */
export type ConfidenceDimension = "presence" | "roomVacancy" | "zoneVacancy" | "ownership" | "energy" | "decision" | (string & {});

export type Confidence = Partial<Record<ConfidenceDimension, number>> & { decision: number };

export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Round a 0..1 score to whole-percent precision for stable storage/printing. */
export const toPct = (n: number): number => Math.round(clamp01(n) * 100);

export interface WeightedScore {
  value: number;
  weight: number;
}

/**
 * Weighted mean of scores, clamped to 0..1. Zero total weight → 0 (no evidence ≠ confident).
 * This is the core combinator for fusing independent signals into one dimension.
 */
export function weightedMean(scores: WeightedScore[]): number {
  let num = 0;
  let den = 0;
  for (const s of scores) {
    const w = Math.max(0, s.weight);
    num += clamp01(s.value) * w;
    den += w;
  }
  return den > 0 ? clamp01(num / den) : 0;
}

/**
 * Roll a dimension breakdown into a single decision score. By default the decision is the WEAKEST
 * link (min) across the provided dimensions — an action is only as trustworthy as its least-certain
 * input — which is the safe default for taking an automatic action. Pass `mode: "mean"` for an
 * averaging roll-up where appropriate.
 */
export function rollUpDecision(dimensions: Record<string, number>, mode: "min" | "mean" = "min"): number {
  const values = Object.values(dimensions).map(clamp01);
  if (values.length === 0) return 0;
  if (mode === "mean") return clamp01(values.reduce((a, b) => a + b, 0) / values.length);
  return clamp01(Math.min(...values));
}

/** Build a Confidence from a dimension map, computing `decision` as the configured roll-up. */
export function makeConfidence(dimensions: Record<string, number>, mode: "min" | "mean" = "min"): Confidence {
  const out: Confidence = { decision: rollUpDecision(dimensions, mode) };
  for (const [k, v] of Object.entries(dimensions)) out[k] = clamp01(v);
  return out;
}
