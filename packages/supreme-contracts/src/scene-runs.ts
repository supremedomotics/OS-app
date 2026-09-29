import { Scene } from "@supreme/domain-model";
import { z } from "zod";

/**
 * Hub-orchestrated Experience activation (ADR 0102 / docs/architecture/homeowner-contract-gate.md §6).
 *
 * The Hub owns orchestration: it resolves the steps (optionally limited to some spaces), runs them
 * phase by phase, and decides — from DEVICE STATE, using the shared `expectationOf` — when each
 * step has been confirmed. A run explains a transition; it is never the answer to "is this
 * Experience active" (clients derive that from device state).
 */

/** queued → sent → confirmed | failed | timeout; `skipped` = never attempted (unreachable / not a
 * valid command). `sent` is also terminal for a step whose effect cannot be verified from state
 * (`verifiable: false`): it was dispatched, and nothing can be claimed beyond that. */
export const SceneRunStepState = z.enum(["queued", "sent", "confirmed", "failed", "timeout", "skipped"]);
export type SceneRunStepState = z.infer<typeof SceneRunStepState>;

export const SceneRunStep = z.object({
  stepId: z.string(),
  deviceId: z.string(),
  roomId: z.string().nullable(),
  capability: z.string(),
  state: SceneRunStepState,
  /** Whether device state can prove this step took effect. */
  verifiable: z.boolean(),
  /** Why a step failed, timed out or was skipped. */
  reason: z.string().nullable().default(null),
});
export type SceneRunStep = z.infer<typeof SceneRunStep>;

export const SceneRunStatus = z.enum(["running", "completed", "partial", "failed"]);
export type SceneRunStatus = z.infer<typeof SceneRunStatus>;

export const SceneRun = z.object({
  runId: z.string(),
  sceneId: z.string(),
  /** The spaces this run was limited to; empty = the whole residence. */
  spaceIds: z.array(z.string()),
  status: SceneRunStatus,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  /** 1-based phase currently executing (0 before the first starts); `phases` is how many there are. */
  phase: z.number().int().nonnegative(),
  phases: z.number().int().nonnegative(),
  steps: z.array(SceneRunStep),
  /** Set when a newer run over the same devices replaced this one. */
  supersededBy: z.string().nullable().default(null),
});
export type SceneRun = z.infer<typeof SceneRun>;

export const ActivateSceneRequest = z.object({
  /** Limit the run to steps whose device is in these spaces (a multi-space Experience: several ids).
   * Omitted or empty = the whole residence. */
  spaceIds: z.array(z.string()).optional(),
});
export type ActivateSceneRequest = z.infer<typeof ActivateSceneRequest>;

export const SceneRunResponse = z.object({ run: SceneRun });
export type SceneRunResponse = z.infer<typeof SceneRunResponse>;

/** A scene as clients read it: the stored scene plus what the Hub derives from its steps. */
export const SceneView = Scene.extend({
  /** Every space a step of this scene acts in (derived from the devices; multi-space scenes list several). */
  roomIds: z.array(z.string()),
});
export type SceneView = z.infer<typeof SceneView>;

/** Stream frame: the full run snapshot on every change (idempotent — apply the latest). */
export const RunFrame = z.object({
  type: z.literal("run"),
  run: SceneRun,
  ts: z.string().datetime(),
});
