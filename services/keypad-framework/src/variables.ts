/**
 * Optional Variables (§ Universal Keypad Framework, Mapping Engine Interface).
 *
 * `KeypadMapping.actions`/`.conditions` are always fully concrete, zod-validated
 * `AutomationAction`/`AutomationCondition` values in storage and at execution time
 * (§ mapping-engine.ts) — a strict schema and a `"{{step}}"` string can't coexist in
 * a `z.number()` field, so variable substitution can never happen at *run* time
 * without either fabricating a permissive schema for the shared Automation DSL (which
 * this framework must not touch) or silently bypassing validation. Instead,
 * substitution happens exactly once, at mapping CREATE/UPDATE time: the caller
 * submits raw, loosely-typed action/condition JSON that may reference a
 * `KeypadMapping.variables` entry anywhere a literal would normally go (including
 * nested fields, e.g. a `device_command` action's `command.level`); `expandVariables`
 * walks that JSON tree substituting every `"{{name}}"` reference, and the RESULT is
 * what gets zod-validated into the stored, concrete mapping (see `service.ts`'s
 * `create`/`update`). `variables` itself is retained on the stored record purely so
 * a future editor can re-surface "this mapping's tunable constants" without having
 * to diff every action back out — it is never re-consulted by the engine.
 */
export function expandVariables(value: unknown, variables: Record<string, string | number | boolean>): unknown {
  if (typeof value === "string") {
    const match = /^\{\{(.+)\}\}$/.exec(value);
    if (!match) return value;
    const name = match[1]!.trim();
    return Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : value;
  }
  if (Array.isArray(value)) return value.map((v) => expandVariables(v, variables));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandVariables(v, variables);
    return out;
  }
  return value;
}
