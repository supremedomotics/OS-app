import {
  CapabilityKind,
  DeviceId,
  KeypadCapabilityDeclaration,
  KeypadMapping,
  KeypadMappingBehavior,
  KeypadMappingInput,
  KeypadMappingTarget,
  KeypadSubscription,
} from "@supreme/domain-model";
import { z } from "zod";

/**
 * Universal Keypad Framework contracts (§ Universal Keypad Framework, Phase 1 —
 * backend APIs only, no visual editor yet). Mirrors `phase3.ts`'s automation
 * contracts shape exactly (Create/Update/Response/List/RunList) for a mapping being
 * a distinct-but-parallel resource, not a fork of the Automation Builder surface.
 */

// ── Keypad capability introspection ─────────────────────────────────────────

export const KeypadCapabilitiesResponse = z.object({ capabilities: KeypadCapabilityDeclaration.nullable() });
export type KeypadCapabilitiesResponse = z.infer<typeof KeypadCapabilitiesResponse>;

// ── Mappings ─────────────────────────────────────────────────────────────────

/**
 * `conditions`/`actions` are accepted as raw JSON records here — NOT the strict
 * `AutomationCondition`/`AutomationAction` unions — because a field may reference a
 * `"{{variable}}"` placeholder from `variables` that only becomes a concrete,
 * schema-valid value after expansion (§ Optional Variables,
 * `@supreme/keypad-framework`'s `expandVariables`). The service expands + validates
 * before anything is stored; an unresolvable placeholder or wrong-shaped action
 * fails with the same 422 validation error the rest of the gateway already produces
 * for a bad automation body (§6 error model).
 *
 * `behavior`/`target` (§ Universal Keypad Framework, Stage 3A) are the API surface for
 * the Stage 2 behavior model — `KeypadMappingBehavior`/`KeypadMappingTarget` are
 * imported straight from `@supreme/domain-model` rather than redeclared here, so this
 * contract can never drift out of sync with the domain schema that actually validates
 * a stored mapping. `actions` drops its old `.min(1)` (a "direct"/"cycle" mapping still
 * needs at least one — enforced by `KeypadMapping`'s own `superRefine` when the service
 * parses the assembled mapping, the SAME place that already enforces every other
 * behavior-conditional rule; duplicating that check here would just be a second source
 * of truth to keep in sync). `behaviorState` is deliberately ABSENT from this contract —
 * it is runtime/persisted engine state the `KeypadMappingEngine` owns exclusively
 * (`lastDirection`/`cycleIndex`), never something a client sets directly; omitting the
 * field here is what actually enforces that, not a comment.
 */
export const CreateKeypadMappingRequest = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  input: KeypadMappingInput,
  conditions: z.array(z.record(z.string(), z.unknown())).default([]),
  actions: z.array(z.record(z.string(), z.unknown())).default([]),
  behavior: KeypadMappingBehavior.default("direct"),
  target: KeypadMappingTarget.nullable().default(null),
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type CreateKeypadMappingRequest = z.infer<typeof CreateKeypadMappingRequest>;

export const UpdateKeypadMappingRequest = CreateKeypadMappingRequest.partial();
export type UpdateKeypadMappingRequest = z.infer<typeof UpdateKeypadMappingRequest>;

export const KeypadMappingResponse = z.object({ mapping: KeypadMapping });
export type KeypadMappingResponse = z.infer<typeof KeypadMappingResponse>;

export const KeypadMappingList = z.object({ mappings: z.array(KeypadMapping) });
export type KeypadMappingList = z.infer<typeof KeypadMappingList>;

export const SetKeypadMappingEnabledRequest = z.object({ enabled: z.boolean() });
export type SetKeypadMappingEnabledRequest = z.infer<typeof SetKeypadMappingEnabledRequest>;

// ── Mapping run traces (mirrors AutomationRun/AutomationRunList in phase3.ts) ────

export const KeypadMappingRunAction = z.object({
  type: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  durationMs: z.number(),
  summary: z.string(),
});
export type KeypadMappingRunAction = z.infer<typeof KeypadMappingRunAction>;

export const KeypadMappingRun = z.object({
  id: z.string(),
  mappingId: z.string(),
  startedAt: z.string(),
  conditionsPassed: z.boolean(),
  failedCondition: z.string().optional(),
  actions: z.array(KeypadMappingRunAction),
  durationMs: z.number(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type KeypadMappingRun = z.infer<typeof KeypadMappingRun>;

export const KeypadMappingRunList = z.object({ runs: z.array(KeypadMappingRun) });
export type KeypadMappingRunList = z.infer<typeof KeypadMappingRunList>;

// ── Feedback subscriptions (§ Subscription Manager) ─────────────────────────

export const CreateKeypadSubscriptionRequest = z.object({
  deviceId: DeviceId,
  capability: CapabilityKind,
  keypadId: DeviceId,
  control: z.string().min(1),
});
export type CreateKeypadSubscriptionRequest = z.infer<typeof CreateKeypadSubscriptionRequest>;

export const KeypadSubscriptionResponse = z.object({ subscription: KeypadSubscription });
export type KeypadSubscriptionResponse = z.infer<typeof KeypadSubscriptionResponse>;

export const KeypadSubscriptionList = z.object({ subscriptions: z.array(KeypadSubscription) });
export type KeypadSubscriptionList = z.infer<typeof KeypadSubscriptionList>;
