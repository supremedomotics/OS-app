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

/**
 * Resolves whether a field is currently required, honoring `requiredIf` (§ Casambi Local
 * Gateway Auth — "Validation must branch immediately based on connection type"). The
 * discriminator field's live value is read from `input` first (what's being saved right now),
 * falling back to `existing` (what's already stored) and finally its own schema default — so a
 * partial save that omits the discriminator still resolves against the driver's actual mode.
 */
function isFieldRequired(
  f: DriverConfigField,
  schema: DriverConfigField[],
  input: Record<string, unknown>,
  existing: Record<string, unknown>,
): boolean {
  if (f.required) return true;
  if (!f.requiredIf) return false;
  const { key, equals } = f.requiredIf;
  const raw = input[key] !== undefined && input[key] !== "" ? input[key] : existing[key];
  const value = raw !== undefined && raw !== "" ? raw : schema.find((c) => c.key === key)?.default;
  return String(value ?? "") === equals;
}

/**
 * Fleet-wide fallback values (e.g. Casambi's `SUPREME_CASAMBI_API_KEY`/`EMAIL`/`PASSWORD` env-var
 * default, § Casambi Driver Refactor — env-var fleet default) that satisfy a required field WITHOUT
 * being written into the persisted config. This keeps a deployment-wide secret out of every
 * individual driver instance's stored config (and out of the encrypted-secrets store) — it's read
 * fresh from the environment every time a value is actually needed, so rotating it takes effect
 * everywhere at once. A field present here counts as "satisfied" for required/requiredIf purposes
 * only when the input/existing config leaves it genuinely blank.
 */
export type ConfigFallbacks = Record<string, unknown>;

export function validateDriverConfig(
  schema: DriverConfigField[],
  input: Record<string, unknown>,
  existing: Record<string, unknown> = {},
  fallbacks: ConfigFallbacks = {},
): ConfigValidation {
  const errors: string[] = [];
  const out: Record<string, unknown> = {};

  for (const f of schema) {
    let v = input[f.key];
    const required = isFieldRequired(f, schema, input, existing);
    const hasFallback = fallbacks[f.key] !== undefined && fallbacks[f.key] !== "";

    // Secret preservation: a field left as the mask (or omitted) keeps the previously stored value.
    if (f.secret && (v === undefined || v === "" || v === SECRET_MASK)) {
      if (existing[f.key] !== undefined) out[f.key] = existing[f.key];
      else if (required && !hasFallback) errors.push(`${f.label} is required`);
      continue;
    }

    if (v === undefined || v === "") {
      if (f.default !== undefined) v = f.default;
      else {
        if (required && !hasFallback) errors.push(`${f.label} is required`);
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

/** Whether every required field is present in a config — drives the "configured" health signal.
 * Honors `requiredIf` the same way {@link validateDriverConfig} does, so a mode-conditional
 * field (e.g. Casambi's Local-only `gatewayIp`) is never flagged missing while a different mode
 * is selected. */
export function isConfigComplete(
  schema: DriverConfigField[],
  config: Record<string, unknown>,
  fallbacks: ConfigFallbacks = {},
): { complete: boolean; missing: string[] } {
  const missing = schema
    .filter(
      (f) =>
        isFieldRequired(f, schema, config, {}) &&
        (config[f.key] === undefined || config[f.key] === "") &&
        (fallbacks[f.key] === undefined || fallbacks[f.key] === ""),
    )
    .map((f) => f.key);
  return { complete: missing.length === 0, missing };
}
