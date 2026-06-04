import {
  newId,
  type HomeId,
  type Notification,
  type NotificationId,
  type NotificationLevel,
  type UserId,
} from "@supreme/domain-model";

/**
 * Notifications service (§13). Local-first: notifications are created on the hub
 * and delivered over WSS to connected clients immediately; when the optional cloud
 * is enabled they additionally fan out to push. Delivery degrades gracefully to
 * on-LAN when cloud is disabled.
 */
export interface INotificationStore {
  add(notification: Notification): Promise<void>;
  listForUser(userId: UserId): Promise<Notification[]>;
  markRead(userId: UserId, ids: string[]): Promise<void>;
}

export class InMemoryNotificationStore implements INotificationStore {
  private readonly items: Notification[] = [];
  async add(n: Notification) {
    this.items.unshift(n);
  }
  async listForUser(userId: UserId) {
    return this.items.filter((n) => n.userId === null || n.userId === userId);
  }
  async markRead(userId: UserId, ids: string[]) {
    const set = new Set(ids);
    for (const n of this.items) {
      if (set.has(n.id) && (n.userId === null || n.userId === userId) && !n.readAt) {
        n.readAt = new Date().toISOString();
      }
    }
  }
}

export type NotificationListener = (n: Notification) => void;

export interface CreateNotificationInput {
  homeId: HomeId;
  userId?: UserId | null;
  level: NotificationLevel;
  title: string;
  body: string;
  context?: Record<string, unknown>;
}

export class NotificationService {
  private readonly store: INotificationStore;
  private readonly listeners = new Set<NotificationListener>();

  constructor(store?: INotificationStore) {
    this.store = store ?? new InMemoryNotificationStore();
  }

  /** Subscribe to newly created notifications (the gateway bridges these to WSS). */
  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: CreateNotificationInput): Promise<Notification> {
    const notification: Notification = {
      id: newId("notification") as NotificationId,
      homeId: input.homeId,
      userId: input.userId ?? null,
      level: input.level,
      title: input.title,
      body: input.body,
      context: input.context ?? {},
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    await this.store.add(notification);
    for (const l of this.listeners) l(notification);
    return notification;
  }

  list(userId: UserId): Promise<Notification[]> {
    return this.store.listForUser(userId);
  }

  markRead(userId: UserId, ids: string[]): Promise<void> {
    return this.store.markRead(userId, ids);
  }
}
