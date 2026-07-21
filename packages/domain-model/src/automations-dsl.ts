import { z } from "zod";
import { CapabilityCommand, CapabilityKind } from "./capabilities.js";
import { AutomationId, DeviceId, HomeId, SceneId, UserId } from "./ids.js";
import { IntentTarget } from "./intents.js";
import { NotificationLevel } from "./notifications.js";
import { ScheduleWindow } from "./users.js";

/**
 * The Supreme automation DSL (§10) — engine-agnostic by construction. The visual
 * Automation Builder edits this JSON DSL (never HA YAML). A native Supreme engine
 * executes it directly (`engine = "supreme"`); the SIL can also compile it to an HA
 * automation (`engine = "ha"`) and store an `externalRef`. Same DSL, swappable
 * executor — the migration guarantee applied to automations.
 */

const Comparator = z.enum(["eq", "ne", "gt", "lt", "gte", "lte", "changed"]);
export type Comparator = z.infer<typeof Comparator>;

// ── Triggers ─────────────────────────────────────────────────────────────────

export const AutomationTrigger = z.discriminatedUnion("type", [
  /** Fires when a device capability's numeric/boolean field meets a comparator. */
  z.object({
    type: z.literal("device_state"),
    deviceId: DeviceId,
    capability: CapabilityKind,
    /** Field within the capability state, e.g. "on", "level", "ambientC". */
    field: z.string(),
    op: Comparator,
    value: z.union([z.number(), z.boolean(), z.string()]).optional(),
  }),
  /** Fires at a wall-clock time on optional weekdays (0=Sun..6=Sat). */
  z.object({
    type: z.literal("time"),
    at: z.string().regex(/^\d{2}:\d{2}$/),
    days: z.array(z.number().int().min(0).max(6)).default([]),
  }),
  /** Fires on a fixed period. */
  z.object({ type: z.literal("interval"), everyMinutes: z.number().int().positive() }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

// ── Conditions (all must hold; evaluated when a trigger fires) ────────────────

export const AutomationCondition = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("device_state"),
    deviceId: DeviceId,
    capability: CapabilityKind,
    field: z.string(),
    op: Comparator,
    value: z.union([z.number(), z.boolean(), z.string()]).optional(),
  }),
  z.object({ type: z.literal("time_window"), window: ScheduleWindow }),
]);
export type AutomationCondition = z.infer<typeof AutomationCondition>;

// ── Actions (run in order) ───────────────────────────────────────────────────

export const AutomationAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("device_command"), deviceId: DeviceId, command: CapabilityCommand }),
  z.object({ type: z.literal("scene_activate"), sceneId: SceneId }),
  z.object({
    type: z.literal("notify"),
    level: NotificationLevel,
    title: z.string(),
    body: z.string(),
    userId: UserId.nullable().default(null),
  }),
  z.object({ type: z.literal("delay"), ms: z.number().int().min(0).max(3_600_000) }),
  /**
   * § Universal Intent & Capability Engine (Phase 2, ADR 0017) — additive, not a
   * replacement for `device_command`. Where `device_command` names a device AND a
   * concrete `CapabilityCommand` explicitly, `intent` names only WHAT the user
   * means (`"toggleLight"`) and a target; `@supreme/intent-engine` resolves the
   * concrete command from whichever capability the target device(s) actually
   * expose at execution time — the same mapping keeps working forever even if
   * the underlying driver/protocol changes. Executed via
   * `AutomationExecutors.runIntent`, reusing the exact same dispatch
   * (`runAutomationAction`) as every other action type — no parallel engine.
   */
  z.object({
    type: z.literal("intent"),
    intentId: z.string().min(1),
    target: IntentTarget,
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  }),
]);
export type AutomationAction = z.infer<typeof AutomationAction>;

// ── The automation record ────────────────────────────────────────────────────

export const Automation = z.object({
  id: AutomationId,
  homeId: HomeId,
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  triggers: z.array(AutomationTrigger).min(1),
  conditions: z.array(AutomationCondition).default([]),
  actions: z.array(AutomationAction).min(1),
  /** "supreme" executes natively on the hub; "ha" compiles to an HA automation. */
  engine: z.enum(["ha", "supreme"]).default("supreme"),
  /** Opaque backend reference (e.g. HA automation id) — owned by the SIL. */
  externalRef: z.string().nullable().default(null),
  /** True while the engine is actively running this automation's actions. */
  aiGenerated: z.boolean().default(false),
});
export type Automation = z.infer<typeof Automation>;
