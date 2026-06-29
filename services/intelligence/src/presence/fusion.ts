/**
 * Presence fusion — blends many independent {@link PresenceSignal}s into one Presence Confidence
 * Score and best-guess location per user. Each signal's vote is weighted by (source reliability ×
 * its own strength × freshness), where freshness decays with a half-life so a stale Wi-Fi
 * association can't keep someone "present" forever. Pure + deterministic: same inputs + `now` →
 * same estimate.
 */
import { clamp01, weightedMean } from "../confidence.js";
import { type PresenceSignal, type PresenceSourceKind, sourceWeight } from "./sources.js";

export interface FusionOptions {
  now: number;
  /** Freshness half-life in ms: a signal this old contributes half its weight. Default 5 min. */
  halfLifeMs?: number;
  /** Signals older than this are dropped entirely. Default 30 min. */
  maxAgeMs?: number;
  /** Fused score ≥ this → "present". Default 0.6. */
  presentThreshold?: number;
  /** Fused score ≤ this → "away". Between the two → "uncertain". Default 0.25. */
  awayThreshold?: number;
  /** Optional per-home override of source reliabilities. */
  weights?: Partial<Record<PresenceSourceKind, number>>;
}

export type PresenceStatus = "present" | "away" | "uncertain";

export interface PresenceEstimate {
  userId: string;
  status: PresenceStatus;
  present: boolean;
  /** 0..1 Presence Confidence Score. */
  confidence: number;
  /** Best-guess room (null when present but room is unknown). */
  roomId: string | null;
  /** Sources that contributed a non-negligible vote, strongest first. */
  contributingSources: PresenceSourceKind[];
  ts: number;
}

/** 0.5^(age / halfLife): 1 at age 0, 0.5 at one half-life, →0 as it ages out. */
function freshness(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

function effectiveWeight(sig: PresenceSignal, opts: Required<Pick<FusionOptions, "now" | "halfLifeMs">> & { weights?: FusionOptions["weights"] }): number {
  const base = opts.weights?.[sig.source] ?? sourceWeight(sig.source);
  return Math.max(0, base) * clamp01(sig.strength) * freshness(opts.now - sig.ts, opts.halfLifeMs);
}

/** Fuse all signals for a single user into one estimate. */
export function fuseUserPresence(userId: string, signals: PresenceSignal[], options: FusionOptions): PresenceEstimate {
  const halfLifeMs = options.halfLifeMs ?? 5 * 60_000;
  const maxAgeMs = options.maxAgeMs ?? 30 * 60_000;
  const presentThreshold = options.presentThreshold ?? 0.6;
  const awayThreshold = options.awayThreshold ?? 0.25;

  const fresh = signals.filter((s) => s.userId === userId && options.now - s.ts <= maxAgeMs);
  const weighted = fresh.map((s) => ({ sig: s, w: effectiveWeight(s, { now: options.now, halfLifeMs, weights: options.weights }) })).filter((x) => x.w > 1e-6);

  // Presence confidence = weighted mean of each source's present/absent vote.
  const confidence = weightedMean(weighted.map((x) => ({ value: x.sig.present ? 1 : 0, weight: x.w })));

  // Location = the room with the greatest aggregate weight among PRESENT signals that name a room.
  const roomWeight = new Map<string, number>();
  for (const x of weighted) {
    if (x.sig.present && typeof x.sig.roomId === "string") {
      roomWeight.set(x.sig.roomId, (roomWeight.get(x.sig.roomId) ?? 0) + x.w);
    }
  }
  let roomId: string | null = null;
  let best = 0;
  for (const [room, w] of roomWeight) {
    if (w > best) {
      best = w;
      roomId = room;
    }
  }

  const status: PresenceStatus = confidence >= presentThreshold ? "present" : confidence <= awayThreshold ? "away" : "uncertain";
  const present = status === "present";

  const contributingSources = [...weighted]
    .sort((a, b) => b.w - a.w)
    .map((x) => x.sig.source)
    .filter((s, i, arr) => arr.indexOf(s) === i);

  return {
    userId,
    status,
    present,
    confidence,
    roomId: present ? roomId : null,
    contributingSources,
    ts: options.now,
  };
}

/** Fuse signals for every user that appears in the input. */
export function fusePresence(signals: PresenceSignal[], options: FusionOptions): PresenceEstimate[] {
  const userIds = [...new Set(signals.map((s) => s.userId))];
  return userIds.map((u) => fuseUserPresence(u, signals, options)).sort((a, b) => b.confidence - a.confidence);
}
