import type {
  Action,
  Grant,
  ResourceType,
  ScheduleWindow,
  User,
} from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import { baselineAllows } from "./roles.js";

/**
 * Supreme policy engine (§8, §12).
 *
 * Evaluation order:
 *   1. Explicit DENY grants always win (deny-overrides).
 *   2. An applicable ALLOW grant (matching resource + action + active time window).
 *   3. Otherwise fall back to the user-type RBAC baseline.
 *
 * "Applicable" requires the grant to match the resource type, optionally the
 * specific resource id, the action, and to be currently active per validFrom /
 * validUntil / weekly schedule — implementing time-based / temporary / expiring
 * access. Decisions are enforced at the gateway and re-checked at services.
 */
export interface AccessRequest {
  user: User;
  resourceType: ResourceType;
  resourceId: string | null;
  action: Action;
  /** Evaluation time; injectable for tests and schedule boundaries. */
  now?: Date;
}

export interface Decision {
  allowed: boolean;
  reason: string;
}

export class PolicyEngine {
  decide(req: AccessRequest, grants: Grant[]): Decision {
    const now = req.now ?? new Date();

    // Expired/suspended users can do nothing.
    if (req.user.status !== "active") {
      return { allowed: false, reason: `user is ${req.user.status}` };
    }
    if (req.user.expiresAt && new Date(req.user.expiresAt) <= now) {
      return { allowed: false, reason: "user access has expired" };
    }

    const applicable = grants.filter((g) => this.matches(g, req, now));

    if (applicable.some((g) => g.effect === "deny")) {
      return { allowed: false, reason: "explicit deny grant" };
    }
    if (applicable.some((g) => g.effect === "allow")) {
      return { allowed: true, reason: "matched allow grant" };
    }
    if (baselineAllows(req.user.userType, req.resourceType, req.action)) {
      return { allowed: true, reason: `${req.user.userType} baseline` };
    }
    return { allowed: false, reason: "no matching grant or baseline" };
  }

  /** Convenience: throw a typed forbidden error when not allowed. */
  enforce(req: AccessRequest, grants: Grant[]): void {
    const decision = this.decide(req, grants);
    if (!decision.allowed) {
      throw new SupremeError("forbidden", `not permitted: ${decision.reason}`);
    }
  }

  private matches(grant: Grant, req: AccessRequest, now: Date): boolean {
    if (grant.userId !== req.user.id) return false;
    if (grant.resourceType !== req.resourceType) return false;
    if (grant.action !== req.action) return false;
    if (grant.resourceId !== null && grant.resourceId !== req.resourceId) return false;
    if (grant.validFrom && new Date(grant.validFrom) > now) return false;
    if (grant.validUntil && new Date(grant.validUntil) <= now) return false;
    if (grant.schedule && !this.inSchedule(grant.schedule, now)) return false;
    return true;
  }

  private inSchedule(windows: ScheduleWindow[], now: Date): boolean {
    if (windows.length === 0) return true;
    const day = now.getDay();
    const minutes = now.getHours() * 60 + now.getMinutes();
    return windows.some((w) => {
      if (!w.days.includes(day)) return false;
      return minutes >= toMinutes(w.start) && minutes < toMinutes(w.end);
    });
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
