import { z } from "zod";
import { AureonTransactionId, DeviceId, HomeId, UserId } from "./ids.js";
import { CapabilityCommand, CapabilityState } from "./capabilities.js";

/**
 * Aureon (§ AUREON-ARCHITECTURE.md §3.7) risk tiers. Purely additive to the domain
 * model — Aureon reuses the EXISTING RBAC/ABAC `PolicyEngine`/`ResourceType`
 * ("intent") for authorization; this tier only decides whether a proposed plan may
 * execute immediately or must be confirmed by the requesting user before Aureon's
 * Action Engine touches anything.
 *
 * 0 READ            read-only queries/explanations
 * 1 LOW_RISK        reversible, low-consequence environmental actions (lighting, blinds)
 * 2 MODERATE        consequential (bulk/multi-room actions, automation/scene creation)
 * 3 HIGH_RISK       security-sensitive (locks, alarm arm/disarm, gates) — always confirmed
 */
export const AureonRiskLevel = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type AureonRiskLevel = z.infer<typeof AureonRiskLevel>;

/**
 * Verification outcomes (§ AUREON-ARCHITECTURE.md §4 step 8). Aureon never reports a
 * command as successful merely because it was accepted for dispatch — every entry is
 * classified from a real post-command state read via the SIL.
 */
export const AureonVerificationStatus = z.enum([
  "verified_success",
  "verified_failure",
  "unverified",
  "timeout",
  "not_supported",
  "denied",
]);
export type AureonVerificationStatus = z.infer<typeof AureonVerificationStatus>;

/** One device-level step inside an {@link AureonTransaction}. */
export const AureonTransactionEntry = z.object({
  deviceId: DeviceId,
  deviceName: z.string(),
  command: CapabilityCommand,
  /** State read via SIL immediately BEFORE dispatch — the only thing undo ever replays. */
  priorState: CapabilityState.nullable(),
  /** State read via SIL after dispatch, once verification completed (null if never read). */
  postState: CapabilityState.nullable(),
  status: AureonVerificationStatus,
  error: z.string().nullable(),
});
export type AureonTransactionEntry = z.infer<typeof AureonTransactionEntry>;

/**
 * A grouped, auditable, undoable unit of Aureon-initiated device changes (§
 * AUREON-ARCHITECTURE.md §3.6). Never a source of physical truth — every field here is
 * a record of what Aureon asked for and what SupremeOS actually verified, not a cache
 * other components should read state from.
 */
export const AureonTransaction = z.object({
  id: AureonTransactionId,
  homeId: HomeId,
  userId: UserId,
  utterance: z.string(),
  riskLevel: AureonRiskLevel,
  createdAt: z.string(),
  entries: z.array(AureonTransactionEntry),
  /** Set when this transaction is itself the result of undoing another one. */
  undoOf: AureonTransactionId.nullable(),
  status: z.enum(["completed", "partially_failed", "failed", "denied"]),
});
export type AureonTransaction = z.infer<typeof AureonTransaction>;
