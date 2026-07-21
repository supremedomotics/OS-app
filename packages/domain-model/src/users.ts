import { z } from "zod";
import { GrantId, HomeId, UserId } from "./ids.js";

/**
 * Supreme identity & permission model (§8).
 *
 * HA users are NOT the user model. The hub provisions a single internal HA service
 * account; every Supreme user maps through the permission layer. The user types below
 * seed baseline roles, and fine-grained grants overlay via an ABAC model
 * (resource + action + time window + schedule).
 */

export const UserType = z.enum([
  "master", // first commissioning user / Super Administrator — full control
  "admin", // Administrator
  "homeowner", // primary resident — full day-to-day control of the home
  "family", // Family Member
  "child",
  "guest", // Guest (often time-bound)
  "staff",
  "installer", // Installer — commissioning, no user administration
  "service_engineer", // Service Engineer — diagnostics / maintenance
  "developer", // Developer — diagnostics + protocol/driver tooling, no user administration
]);
export type UserType = z.infer<typeof UserType>;

export const UserStatus = z.enum(["active", "suspended", "expired"]);
export type UserStatus = z.infer<typeof UserStatus>;

export const User = z.object({
  id: UserId,
  homeId: HomeId,
  email: z.string().email(),
  phone: z.string().nullable(),
  displayName: z.string().min(1),
  userType: UserType,
  status: UserStatus.default("active"),
  /** Whether the email address has been verified (§ Authentication — email verification). Defaults
   * false for invited users; the master (who commissions the home) is verified on creation. */
  emailVerified: z.boolean().default(false),
  createdAt: z.string().datetime(),
  /** Temporary / expiring users (guests, staff) — null = no expiry. */
  expiresAt: z.string().datetime().nullable(),
});
export type User = z.infer<typeof User>;

// ── Permissions (RBAC baseline + ABAC overlay) ───────────────────────────────

export const ResourceType = z.enum([
  "room",
  "device",
  "scene",
  "automation",
  "camera",
  "integration",
  "user",
  "home",
  /** Universal Keypad Framework input→action mappings + feedback subscriptions
   * (§ Universal Keypad Framework) — deliberately its own resource type rather than
   * folded into "automation": a keypad mapping is authored/managed as installer
   * commissioning work (bus binding-adjacent), not a homeowner automation. */
  "keypad_mapping",
]);
export type ResourceType = z.infer<typeof ResourceType>;

export const Action = z.enum(["view", "control", "create", "update", "delete", "admin"]);
export type Action = z.infer<typeof Action>;

export const Effect = z.enum(["allow", "deny"]);
export type Effect = z.infer<typeof Effect>;

/**
 * A weekly schedule window for time-based access. Days are 0 (Sun) .. 6 (Sat);
 * times are "HH:MM" 24h local to the home. Empty = always.
 */
export const ScheduleWindow = z.object({
  days: z.array(z.number().int().min(0).max(6)),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});
export type ScheduleWindow = z.infer<typeof ScheduleWindow>;

export const Grant = z.object({
  id: GrantId,
  userId: UserId,
  resourceType: ResourceType,
  /** null = applies to all resources of this type within the home. */
  resourceId: z.string().nullable(),
  action: Action,
  effect: Effect.default("allow"),
  validFrom: z.string().datetime().nullable(),
  validUntil: z.string().datetime().nullable(),
  schedule: z.array(ScheduleWindow).nullable(),
});
export type Grant = z.infer<typeof Grant>;
