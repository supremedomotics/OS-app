import { sha256Hex } from "@supreme/crypto";
import { uuidv7 } from "@supreme/hub-identity";

/**
 * @supreme/admin — internal operations (blueprint §4, §17): feature flags with deterministic
 * percentage rollout, and SUPPORT IMPERSONATION that is always time-boxed, consent/justification-
 * bound, and emits an audit record (the Admin Console is otherwise a thin consumer of the Audit
 * and Identity services). Impersonation never bypasses a home's RBAC — it acts AS an account,
 * and is fully logged.
 */

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  /** 0–100 deterministic rollout when enabled (by subject id). */
  rolloutPercent: number;
}

export interface ImpersonationGrant {
  id: string;
  adminAccountId: string;
  targetAccountId: string;
  reason: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

/** An audit-worthy record the caller should append to the hash-chained Audit log. */
export interface AuditableAction {
  action: string;
  actorAccountId: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
}

export class AdminService {
  private flags = new Map<string, FeatureFlag>();
  private grants = new Map<string, ImpersonationGrant>();
  private readonly now: () => number;
  private readonly impersonationTtlMs: number;

  constructor(opts: { now?: () => number; impersonationTtlMs?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.impersonationTtlMs = opts.impersonationTtlMs ?? 30 * 60_000; // 30 min
  }

  // ── Feature flags ───────────────────────────────────────────────────────────────────────
  setFlag(key: string, enabled: boolean, rolloutPercent = 100): FeatureFlag {
    const flag: FeatureFlag = { key, enabled, rolloutPercent: Math.max(0, Math.min(100, rolloutPercent)) };
    this.flags.set(key, flag);
    return flag;
  }

  /** Deterministic per-subject evaluation (a subject never flip-flops within a rollout). */
  isEnabled(key: string, subjectId = "global"): boolean {
    const flag = this.flags.get(key);
    if (!flag || !flag.enabled) return false;
    if (flag.rolloutPercent >= 100) return true;
    if (flag.rolloutPercent <= 0) return false;
    const bucket = (parseInt(sha256Hex(`${key}|${subjectId}`).slice(0, 8), 16) % 10_000) / 100;
    return bucket < flag.rolloutPercent;
  }

  // ── Audited impersonation ─────────────────────────────────────────────────────────────────
  /** Begin a time-boxed impersonation; returns the grant + the audit record to persist. */
  startImpersonation(input: { adminAccountId: string; targetAccountId: string; reason: string }): {
    grant: ImpersonationGrant;
    audit: AuditableAction;
  } {
    if (!input.reason || input.reason.trim().length === 0) {
      throw new Error("impersonation requires a justification");
    }
    const grant: ImpersonationGrant = {
      id: uuidv7(this.now()),
      adminAccountId: input.adminAccountId,
      targetAccountId: input.targetAccountId,
      reason: input.reason,
      issuedAt: this.now(),
      expiresAt: this.now() + this.impersonationTtlMs,
      revokedAt: null,
    };
    this.grants.set(grant.id, grant);
    return {
      grant,
      audit: {
        action: "admin.impersonation.start",
        actorAccountId: input.adminAccountId,
        resourceType: "account",
        resourceId: input.targetAccountId,
        metadata: { reason: input.reason, grantId: grant.id, expiresAt: grant.expiresAt },
      },
    };
  }

  endImpersonation(grantId: string): void {
    const g = this.grants.get(grantId);
    if (g && !g.revokedAt) g.revokedAt = this.now();
  }

  /** Whether an impersonation grant is currently active (within window + not revoked). */
  isImpersonationActive(grantId: string): boolean {
    const g = this.grants.get(grantId);
    if (!g || g.revokedAt) return false;
    return this.now() >= g.issuedAt && this.now() < g.expiresAt;
  }
}
