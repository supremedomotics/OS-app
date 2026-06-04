import {
  Automation,
  AutomationAction,
  AutomationCondition,
  AutomationTrigger,
} from "@supreme/domain-model";
import { z } from "zod";

/**
 * Phase-3 contracts (§16): the visual Automation Builder DSL surface, energy
 * analytics, advanced audit, and the AI assistant. All Supreme — backend-agnostic.
 */

// ── Automations ──────────────────────────────────────────────────────────────

export const CreateAutomationRequest = z.object({
  name: z.string().min(1),
  triggers: z.array(AutomationTrigger).min(1),
  conditions: z.array(AutomationCondition).default([]),
  actions: z.array(AutomationAction).min(1),
  engine: z.enum(["ha", "supreme"]).default("supreme"),
  enabled: z.boolean().default(true),
});
export type CreateAutomationRequest = z.infer<typeof CreateAutomationRequest>;

export const UpdateAutomationRequest = CreateAutomationRequest.partial();
export type UpdateAutomationRequest = z.infer<typeof UpdateAutomationRequest>;

export const AutomationResponse = z.object({ automation: Automation });
export type AutomationResponse = z.infer<typeof AutomationResponse>;

export const AutomationList = z.object({ automations: z.array(Automation) });
export type AutomationList = z.infer<typeof AutomationList>;

export const SetAutomationEnabledRequest = z.object({ enabled: z.boolean() });
export type SetAutomationEnabledRequest = z.infer<typeof SetAutomationEnabledRequest>;

// ── Energy / analytics ───────────────────────────────────────────────────────

export const MeasureSummary = z.object({
  measure: z.string(),
  total: z.number(),
  average: z.number(),
  count: z.number().int(),
  unit: z.string(),
});
export const EnergySummaryResponse = z.object({
  summary: z.array(MeasureSummary),
  topConsumers: z.array(z.object({ deviceId: z.string(), total: z.number(), unit: z.string() })),
});
export type EnergySummaryResponse = z.infer<typeof EnergySummaryResponse>;

export const DeviceEnergyResponse = z.object({
  series: z.array(z.object({ hour: z.string(), total: z.number(), average: z.number() })),
});
export type DeviceEnergyResponse = z.infer<typeof DeviceEnergyResponse>;

// ── Advanced audit ───────────────────────────────────────────────────────────

export const AuditEntry = z.object({
  id: z.string(),
  seq: z.number().int(),
  actorUserId: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
  entryHash: z.string(),
});
export const AuditList = z.object({ entries: z.array(AuditEntry) });
export type AuditList = z.infer<typeof AuditList>;

export const AuditVerifyResponse = z.object({
  ok: z.boolean(),
  brokenAtSeq: z.number().int().optional(),
});
export type AuditVerifyResponse = z.infer<typeof AuditVerifyResponse>;

// ── AI assistant ─────────────────────────────────────────────────────────────

export const AiAssistRequest = z.object({ utterance: z.string().min(1) });
export type AiAssistRequest = z.infer<typeof AiAssistRequest>;

/** The assistant returns a draft the user confirms (actions/scene/automation/answer). */
export const AiAssistResponse = z.object({
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("actions"), summary: z.string(), commands: z.array(z.unknown()) }),
    z.object({ kind: z.literal("scene"), summary: z.string(), name: z.string(), steps: z.array(z.unknown()) }),
    z.object({
      kind: z.literal("automation"),
      summary: z.string(),
      name: z.string(),
      triggers: z.array(z.unknown()),
      actions: z.array(z.unknown()),
    }),
    z.object({ kind: z.literal("answer"), summary: z.string() }),
  ]),
});
export type AiAssistResponse = z.infer<typeof AiAssistResponse>;
