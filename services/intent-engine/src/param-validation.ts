import type { IntentDefinition, IntentParameterSpec } from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";

/**
 * Intent parameter validation (§ Universal Intent & Capability Engine). Real
 * validation against each `IntentParameterSpec` — required/type/min/max/enum
 * options — never trusting a caller's params blindly, whether that caller is a
 * keypad mapping, an automation, a direct REST call, or a future AI assistant.
 * Fills in declared defaults for anything the caller omitted. Extracted as its
 * own module (mirrors `condition-eval.ts`'s precedent) so it's independently
 * testable and reusable without pulling in the whole engine.
 */
export function validateIntentParams(
  definition: IntentDefinition,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...params };
  for (const spec of definition.parameters) {
    if (resolved[spec.key] === undefined) {
      if (spec.required) {
        throw new SupremeError(
          "validation_failed",
          `intent "${definition.id}" is missing required parameter "${spec.key}"`,
        );
      }
      if (spec.default !== undefined) resolved[spec.key] = spec.default;
      continue;
    }
    validateOne(definition.id, spec, resolved[spec.key]);
  }
  return resolved;
}

function validateOne(intentId: string, spec: IntentParameterSpec, value: unknown): void {
  switch (spec.type) {
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        throw new SupremeError("validation_failed", `intent "${intentId}" parameter "${spec.key}" must be a number`);
      }
      if (spec.min !== undefined && value < spec.min) {
        throw new SupremeError("validation_failed", `intent "${intentId}" parameter "${spec.key}" must be >= ${spec.min}`);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw new SupremeError("validation_failed", `intent "${intentId}" parameter "${spec.key}" must be <= ${spec.max}`);
      }
      return;
    }
    case "boolean":
      if (typeof value !== "boolean") {
        throw new SupremeError("validation_failed", `intent "${intentId}" parameter "${spec.key}" must be a boolean`);
      }
      return;
    case "string":
      if (typeof value !== "string") {
        throw new SupremeError("validation_failed", `intent "${intentId}" parameter "${spec.key}" must be a string`);
      }
      return;
    case "enum":
      if (typeof value !== "string" || !(spec.options ?? []).includes(value)) {
        throw new SupremeError(
          "validation_failed",
          `intent "${intentId}" parameter "${spec.key}" must be one of: ${(spec.options ?? []).join(", ")}`,
        );
      }
      return;
  }
}
