import { z } from "zod";
import { DeviceId, HomeId, NotificationId, SceneId, UserId } from "./ids.js";

/**
 * Homeowner-facing notifications (§11, §13). Generated on the hub (device offline,
 * security events, automation results) and delivered over WSS to subscribed
 * clients; when the optional cloud is enabled they also fan out to push. They
 * degrade gracefully to on-LAN delivery when cloud is disabled.
 */
export const NotificationLevel = z.enum(["info", "warning", "critical"]);
export type NotificationLevel = z.infer<typeof NotificationLevel>;

export const Notification = z.object({
  id: NotificationId,
  homeId: HomeId,
  /** Target user; null = broadcast to all home members. */
  userId: UserId.nullable(),
  level: NotificationLevel,
  title: z.string().min(1),
  body: z.string(),
  /** Optional deep-link context, e.g. { deviceId } or { sceneId }. */
  context: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
  readAt: z.string().datetime().nullable(),
});
export type Notification = z.infer<typeof Notification>;

/**
 * Per-user favorites surfaced on the dashboard (§11.3). A favorite references a
 * device or a scene; order is user-controlled for the quick-access row.
 */
export const FavoriteRef = z.discriminatedUnion("type", [
  z.object({ type: z.literal("device"), deviceId: DeviceId }),
  z.object({ type: z.literal("scene"), sceneId: SceneId }),
]);
export type FavoriteRef = z.infer<typeof FavoriteRef>;

export const Favorite = z.object({
  userId: UserId,
  ref: FavoriteRef,
  sortOrder: z.number().int().default(0),
});
export type Favorite = z.infer<typeof Favorite>;
