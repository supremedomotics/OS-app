import type { DriverConfigField } from "@supreme/domain-model";

/**
 * Universal driver config validation. Given a driver's declared {@link DriverConfigField} schema and
 * a submitted config, it coerces types, applies defaults, enforces required/min/max/select, and
 * PRESERVES secrets the UI sent back masked (so editing a form doesn't wipe a stored password). Pure
 * + deterministic — the same validator the Driver Manager UI and the REST layer both rely on.
 */
export const SECRET_MASK = "••••••••";

export interface ConfigValidation {
  config: Record<string, unknown>;
  errors: string[];
}

export function validateDriverConfig(
  schema: DriverConfigField[],
  input: Record<string, unknown>,
  existing: Record<string, unknown> = {},
): ConfigValidation {
  const errors: string[] = [];
  const out: Record<string, unknown> = {};

  for (const f of schema) {
    let v = input[f.key];

    // Secret preservation: a field left as the mask (or omitted) keeps the previously stored value.
    if (f.secret && (v === undefined || v === "" || v === SECRET_MASK)) {
      if (existing[f.key] !== undefined) out[f.key] = existing[f.key];
      else if (f.required) errors.push(`${f.label} is required`);
      continue;
    }

    if (v === undefined || v === "") {
      if (f.default !== undefined) v = f.default;
      else {
        if (f.required) errors.push(`${f.label} is required`);
        continue;
      }
    }

    switch (f.type) {
      case "number":
      case "port": {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          errors.push(`${f.label} must be a number`);
          break;
        }
        const min = f.type === "port" && f.min === undefined ? 1 : f.min;
        const max = f.type === "port" && f.max === undefined ? 65535 : f.max;
        if (min !== undefined && n < min) errors.push(`${f.label} must be ≥ ${min}`);
        else if (max !== undefined && n > max) errors.push(`${f.label} must be ≤ ${max}`);
        else out[f.key] = n;
        break;
      }
      case "boolean":
        out[f.key] = v === true || v === "true" || v === 1 || v === "1";
        break;
      case "select": {
        const allowed = (f.options ?? []).map((o) => o.value);
        if (allowed.length > 0 && !allowed.includes(String(v))) errors.push(`${f.label} is not a valid option`);
        else out[f.key] = String(v);
        break;
      }
      default:
        out[f.key] = String(v);
    }
  }

  return { config: out, errors };
}

/** The default config for a schema (its declared defaults) — applied when a driver is first installed. */
export function defaultDriverConfig(schema: DriverConfigField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema) if (f.default !== undefined) out[f.key] = f.default;
  return out;
}

/** Whether every required field is present in a config — drives the "configured" health signal. */
export function isConfigComplete(schema: DriverConfigField[], config: Record<string, unknown>): { complete: boolean; missing: string[] } {
  const missing = schema.filter((f) => f.required && (config[f.key] === undefined || config[f.key] === "")).map((f) => f.key);
  return { complete: missing.length === 0, missing };
}
