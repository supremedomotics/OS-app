/**
 * @supreme/permissions — central authorization for the hub (§8, §12).
 * RBAC baseline (roles.ts) + ABAC overlay with time-based grants (policy.ts).
 */
export { PolicyEngine, type AccessRequest, type Decision } from "./policy.js";
export { BASELINE_ROLES, baselineAllows, type RolePolicy } from "./roles.js";
export {
  InMemoryGrantStore,
  buildGrant,
  type IGrantStore,
  type CreateGrantInput,
} from "./grant-store.js";
