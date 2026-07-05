/**
 * @supreme/cloud-authz — the cloud Policy Decision Point (blueprint §11, ADR 0007).
 *
 * RBAC baseline (per-home role → resource-domain capability) plus an ABAC grant overlay
 * (per-resource allow/deny with optional time windows). This MIRRORS the hub's local
 * permission model so cloud APIs and the hub enforce the same rules; the hub stays the
 * authoritative enforcement point for in-home actions (so authorization works offline).
 *
 * Pure, deterministic logic — no I/O — so it is trivially testable and embeddable at the edge.
 */

export type Role = "owner" | "admin" | "installer" | "homeowner" | "family" | "guest" | "service";

export type Domain =
  | "rooms"
  | "devices"
  | "scenes"
  | "automation"
  | "cameras"
  | "security"
  | "schedules"
  | "notifications"
  | "remote_access"
  | "installer_portal"
  | "firmware"
  | "diagnostics";

export type Action = "view" | "control" | "manage";

/** Capability level a role holds over a domain: none < scoped < full. */
export type Level = "none" | "scoped" | "full";

/**
 * Baseline role → domain → level matrix (blueprint §11). "scoped" means limited/own-resource
 * access subject to the ABAC overlay; "full" is unrestricted within the home.
 */
const MATRIX: Record<Role, Partial<Record<Domain, Level>>> = {
  owner: fill("full"),
  admin: { ...fill("full"), installer_portal: "scoped", firmware: "scoped" },
  installer: {
    rooms: "full", devices: "full", scenes: "full", automation: "full", schedules: "full",
    cameras: "scoped", notifications: "scoped", remote_access: "scoped",
    installer_portal: "full", firmware: "full", diagnostics: "full", security: "none",
  },
  homeowner: {
    rooms: "full", devices: "full", scenes: "full", automation: "full", schedules: "full",
    cameras: "scoped", security: "scoped", notifications: "full", remote_access: "full",
    diagnostics: "scoped", installer_portal: "none", firmware: "none",
  },
  family: {
    rooms: "scoped", devices: "scoped", scenes: "scoped", automation: "scoped", schedules: "scoped",
    cameras: "scoped", security: "scoped", notifications: "scoped", remote_access: "scoped",
    diagnostics: "none", installer_portal: "none", firmware: "none",
  },
  guest: {
    rooms: "scoped", devices: "scoped", cameras: "none", security: "none", scenes: "none",
    automation: "none", schedules: "none", notifications: "scoped", remote_access: "scoped",
    diagnostics: "none", installer_portal: "none", firmware: "none",
  },
  service: {
    rooms: "scoped", devices: "scoped", scenes: "scoped", automation: "scoped", schedules: "scoped",
    cameras: "scoped", security: "none", notifications: "scoped", remote_access: "scoped",
    diagnostics: "full", installer_portal: "scoped", firmware: "scoped",
  },
};

function fill(level: Level): Record<Domain, Level> {
  const domains: Domain[] = [
    "rooms", "devices", "scenes", "automation", "cameras", "security", "schedules",
    "notifications", "remote_access", "installer_portal", "firmware", "diagnostics",
  ];
  return Object.fromEntries(domains.map((d) => [d, level])) as Record<Domain, Level>;
}

/** Minimum capability level an action requires. */
const ACTION_LEVEL: Record<Action, Level> = { view: "scoped", control: "scoped", manage: "full" };
const ORDER: Record<Level, number> = { none: 0, scoped: 1, full: 2 };

export interface Membership {
  role: Role;
  /** Membership validity window (e.g. time-boxed guest/service access). */
  validFrom?: number;
  validUntil?: number | null;
}

/** ABAC grant overlay — explicit per-resource allow/deny that overrides the baseline. */
export interface Grant {
  domain: Domain;
  /** Specific resource id, or null = applies to the whole domain. */
  resourceId?: string | null;
  action: Action;
  effect: "allow" | "deny";
  validUntil?: number | null;
}

export interface DecisionInput {
  membership: Membership;
  domain: Domain;
  action: Action;
  resourceId?: string | null;
  grants?: Grant[];
  now?: number;
}

export interface Decision {
  allow: boolean;
  reason: string;
}

/** The policy decision: membership window → explicit grants (deny wins) → baseline matrix. */
export function decide(input: DecisionInput): Decision {
  const now = input.now ?? Date.now();
  const m = input.membership;

  // 1. Membership must be within its validity window (time-boxed guest/service access).
  if (m.validFrom !== undefined && now < m.validFrom) return deny("membership not yet active");
  if (m.validUntil != null && now >= m.validUntil) return deny("membership expired");

  // 2. Explicit grants override the baseline; an applicable DENY always wins.
  const applicable = (input.grants ?? []).filter(
    (g) =>
      g.domain === input.domain &&
      g.action === input.action &&
      (g.resourceId == null || g.resourceId === input.resourceId) &&
      (g.validUntil == null || now < g.validUntil),
  );
  if (applicable.some((g) => g.effect === "deny")) return deny("explicit deny grant");
  if (applicable.some((g) => g.effect === "allow")) return { allow: true, reason: "explicit allow grant" };

  // 3. Baseline RBAC matrix.
  const level = MATRIX[m.role]?.[input.domain] ?? "none";
  if (ORDER[level] >= ORDER[ACTION_LEVEL[input.action]]) {
    return { allow: true, reason: `role ${m.role} has ${level} on ${input.domain}` };
  }
  return deny(`role ${m.role} lacks ${input.action} on ${input.domain}`);
}

function deny(reason: string): Decision {
  return { allow: false, reason };
}

/** The capability level a role holds over a domain (for UI affordance hints). */
export function roleLevel(role: Role, domain: Domain): Level {
  return MATRIX[role]?.[domain] ?? "none";
}
