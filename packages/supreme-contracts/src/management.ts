import {
  Action,
  Favorite,
  FavoriteRef,
  Grant,
  Notification,
  ResourceType,
  Scene,
  SceneStep,
  ScheduleWindow,
  User,
  UserType,
} from "@supreme/domain-model";
import { z } from "zod";

/**
 * Phase-1 management contracts (§6, §8, §10, §11): scenes, user management,
 * grants (time-based access), favorites, and notifications. All "Supreme", no HA.
 */

// ── Scenes ───────────────────────────────────────────────────────────────────

export const CreateSceneRequest = z.object({
  name: z.string().min(1),
  scope: z.enum(["room", "home"]).default("room"),
  roomId: z.string().nullable().default(null),
  icon: z.string().nullable().default(null),
  steps: z.array(SceneStep),
});
export type CreateSceneRequest = z.infer<typeof CreateSceneRequest>;

export const UpdateSceneRequest = CreateSceneRequest.partial();
export type UpdateSceneRequest = z.infer<typeof UpdateSceneRequest>;

export const SceneResponse = z.object({ scene: Scene });
export type SceneResponse = z.infer<typeof SceneResponse>;

export const ActivateSceneResponse = z.object({
  activated: z.boolean(),
  /** How many of the scene's steps were dispatched to the SIL. */
  steps: z.number().int().nonnegative(),
});
export type ActivateSceneResponse = z.infer<typeof ActivateSceneResponse>;

// ── User management (master/admin flows) ─────────────────────────────────────

export const CreateUserRequest = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1),
  userType: UserType,
  /** Temporary/expiring access (guests, staff). */
  expiresAt: z.string().datetime().nullable().default(null),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

export const UserResponse = z.object({ user: User });
export type UserResponse = z.infer<typeof UserResponse>;

// ── Account self-service (§ Authentication / Security Center) ─────────────────

/** Change the signed-in user's email/username. Requires the current password (re-auth). */
export const ChangeEmailRequest = z.object({
  newEmail: z.string().email(),
  currentPassword: z.string().min(1),
});
export type ChangeEmailRequest = z.infer<typeof ChangeEmailRequest>;

/** Delete the signed-in user's own account. Re-auth with the current password. */
export const DeleteAccountRequest = z.object({
  currentPassword: z.string().min(1),
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;

/** One login session in the Security Center's active-sessions / login-history list. */
export const SessionView = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  revoked: z.boolean(),
  /** True for the session the request is being made from — the UI marks it "This device". */
  current: z.boolean(),
});
export type SessionView = z.infer<typeof SessionView>;

export const SessionList = z.object({ sessions: z.array(SessionView) });
export type SessionList = z.infer<typeof SessionList>;

export const RevokeOthersResponse = z.object({ revoked: z.number().int().nonnegative() });
export type RevokeOthersResponse = z.infer<typeof RevokeOthersResponse>;

// ── Personal API tokens (§ Security Center) ──────────────────────────────────

export const ApiTokenView = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revoked: z.boolean(),
});
export type ApiTokenView = z.infer<typeof ApiTokenView>;

export const ApiTokenList = z.object({ tokens: z.array(ApiTokenView) });
export type ApiTokenList = z.infer<typeof ApiTokenList>;

export const CreateApiTokenRequest = z.object({ name: z.string().min(1).max(80).default("API token") });
export type CreateApiTokenRequest = z.infer<typeof CreateApiTokenRequest>;

/** The plaintext token is returned ONCE at creation. */
export const CreateApiTokenResponse = z.object({ token: z.string(), meta: ApiTokenView });
export type CreateApiTokenResponse = z.infer<typeof CreateApiTokenResponse>;

// ── Grants (ABAC overlay) ────────────────────────────────────────────────────

export const CreateGrantRequest = z.object({
  resourceType: ResourceType,
  resourceId: z.string().nullable().default(null),
  action: Action,
  effect: z.enum(["allow", "deny"]).default("allow"),
  validFrom: z.string().datetime().nullable().default(null),
  validUntil: z.string().datetime().nullable().default(null),
  schedule: z.array(ScheduleWindow).nullable().default(null),
});
export type CreateGrantRequest = z.infer<typeof CreateGrantRequest>;

export const GrantList = z.object({ grants: z.array(Grant) });
export type GrantList = z.infer<typeof GrantList>;

export const GrantResponse = z.object({ grant: Grant });
export type GrantResponse = z.infer<typeof GrantResponse>;

// ── Favorites ────────────────────────────────────────────────────────────────

export const FavoriteList = z.object({ favorites: z.array(Favorite) });
export type FavoriteList = z.infer<typeof FavoriteList>;

export const SetFavoriteRequest = z.object({
  ref: FavoriteRef,
  /** true = add/keep, false = remove. */
  favorite: z.boolean().default(true),
});
export type SetFavoriteRequest = z.infer<typeof SetFavoriteRequest>;

// ── Notifications ────────────────────────────────────────────────────────────

export const NotificationList = z.object({ notifications: z.array(Notification) });
export type NotificationList = z.infer<typeof NotificationList>;

export const MarkReadRequest = z.object({ ids: z.array(z.string()) });
export type MarkReadRequest = z.infer<typeof MarkReadRequest>;
