import type { HomeId, Notification, NotificationId, UserId } from "@supreme/domain-model";
import type { INotificationStore } from "@supreme/notifications";
import type { SqlDb } from "../sql-db.js";

interface NotifRow {
  id: string;
  home_id: string;
  user_id: string | null;
  level: string;
  title: string;
  body: string;
  context: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
}

function rowToNotification(r: NotifRow): Notification {
  return {
    id: r.id as NotificationId,
    homeId: r.home_id as HomeId,
    userId: (r.user_id as UserId | null) ?? null,
    level: r.level as Notification["level"],
    title: r.title,
    body: r.body,
    context: r.context,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

/** Postgres-backed {@link INotificationStore}. */
export class NotificationRepo implements INotificationStore {
  constructor(private readonly db: SqlDb) {}

  async add(n: Notification): Promise<void> {
    await this.db.query(
      `INSERT INTO notifications (id, home_id, user_id, level, title, body, context, created_at, read_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [n.id, n.homeId, n.userId, n.level, n.title, n.body, JSON.stringify(n.context), n.createdAt, n.readAt],
    );
  }
  async listForUser(userId: UserId): Promise<Notification[]> {
    const { rows } = await this.db.query<NotifRow>(
      "SELECT * FROM notifications WHERE user_id IS NULL OR user_id=$1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map(rowToNotification);
  }
  async markRead(userId: UserId, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query(
      `UPDATE notifications SET read_at=$1
       WHERE read_at IS NULL AND (user_id IS NULL OR user_id=$2) AND id = ANY($3)`,
      [new Date().toISOString(), userId, ids],
    );
  }
}
