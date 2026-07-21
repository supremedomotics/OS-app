import { IntentDefinition, IntentTarget } from "@supreme/domain-model";
import { z } from "zod";

/**
 * Universal Intent & Capability Engine contracts (§ Phase 2, ADR 0017). The Intent
 * Registry's public catalog (for a future Universal Keypad Editor, AI assistant, or
 * marketplace template importer) plus direct invocation (testing, and the same
 * mechanism any of those future callers would use).
 */

export const IntentDefinitionList = z.object({ intents: z.array(IntentDefinition) });
export type IntentDefinitionList = z.infer<typeof IntentDefinitionList>;

export const IntentDefinitionResponse = z.object({ intent: IntentDefinition });
export type IntentDefinitionResponse = z.infer<typeof IntentDefinitionResponse>;

export const RunIntentRequest = z.object({
  target: IntentTarget,
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type RunIntentRequest = z.infer<typeof RunIntentRequest>;

/** Mirrors `@supreme/intent-engine`'s `IntentRun` — one execution trace. */
export const IntentRunRecord = z.object({
  id: z.string(),
  intentId: z.string(),
  target: IntentTarget,
  startedAt: z.string(),
  resolvedDeviceIds: z.array(z.string()),
  durationMs: z.number(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type IntentRunRecord = z.infer<typeof IntentRunRecord>;

export const RunIntentResponse = z.object({ run: IntentRunRecord });
export type RunIntentResponse = z.infer<typeof RunIntentResponse>;

export const IntentRunList = z.object({ runs: z.array(IntentRunRecord) });
export type IntentRunList = z.infer<typeof IntentRunList>;
