/**
 * @supreme/notification — the cloud Notification service (blueprint §10).
 *
 * Events ORIGINATE on the hub (doorbell, motion, alarm, scene, automation alert). The hub
 * sends a notification request to this service, which fans out to the account's registered
 * devices via platform providers (APNs/FCM/WebPush/Wear/Watch). The cloud only DELIVERS —
 * it never generates notifications and (for E2E-encrypted payloads) can route without reading
 * the body. Adds targeting, per-account quiet hours, dedup/suppression, and delivery receipts.
 *
 * Pure orchestration over injectable seams (providers + token source) — unit-testable.
 */

export type Platform = "apns" | "fcm" | "webpush" | "wearos" | "watchos";
export type Priority = "low" | "normal" | "high" | "critical";

export interface PushTarget {
  deviceId: string;
  platform: Platform;
  token: string;
}

export interface PushPayload {
  title: string;
  body: string;
  category: string;
  priority: Priority;
  data?: Record<string, string>;
}

export interface IPushProvider {
  readonly platform: Platform;
  deliver(token: string, payload: PushPayload): Promise<void>;
}

/** Resolves an account's deliverable push targets (backed by the Device Registry in prod). */
export interface IPushTokenSource {
  targetsFor(accountId: string): PushTarget[];
}

/** Per-account quiet-hours window (local minutes-of-day); critical alerts bypass it. */
export interface QuietHours {
  startMinute: number; // e.g. 22:00 → 1320
  endMinute: number; // e.g. 07:00 → 420 (wraps past midnight)
}

export interface NotifyInput {
  accountId: string;
  payload: PushPayload;
  /** Suppress duplicates sharing this key within the dedup window. */
  dedupeKey?: string;
  /** Minutes-of-day at the recipient now (for quiet-hours evaluation). */
  localMinute?: number;
}

export interface Receipt {
  deviceId: string;
  platform: Platform;
  status: "delivered" | "failed";
  error?: string;
}

export interface NotifyResult {
  status: "delivered" | "suppressed_quiet_hours" | "suppressed_duplicate" | "no_targets";
  receipts: Receipt[];
}

export interface NotificationOptions {
  providers: IPushProvider[];
  tokens: IPushTokenSource;
  quietHoursFor?: (accountId: string) => QuietHours | null;
  /** Dedup window in ms (default 60s). */
  dedupeWindowMs?: number;
  now?: () => number;
}

function inQuietHours(minute: number, q: QuietHours): boolean {
  // Window may wrap past midnight (start > end).
  return q.startMinute <= q.endMinute
    ? minute >= q.startMinute && minute < q.endMinute
    : minute >= q.startMinute || minute < q.endMinute;
}

export class NotificationService {
  private readonly providers = new Map<Platform, IPushProvider>();
  private readonly tokens: IPushTokenSource;
  private readonly quietHoursFor?: (accountId: string) => QuietHours | null;
  private readonly dedupeWindowMs: number;
  private readonly now: () => number;
  private readonly recentDedupe = new Map<string, number>();

  constructor(opts: NotificationOptions) {
    for (const p of opts.providers) this.providers.set(p.platform, p);
    this.tokens = opts.tokens;
    this.quietHoursFor = opts.quietHoursFor;
    this.dedupeWindowMs = opts.dedupeWindowMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async notify(input: NotifyInput): Promise<NotifyResult> {
    const now = this.now();

    // 1. Dedup — suppress a repeat of the same logical event within the window.
    if (input.dedupeKey) {
      const last = this.recentDedupe.get(input.dedupeKey);
      if (last !== undefined && now - last < this.dedupeWindowMs) {
        return { status: "suppressed_duplicate", receipts: [] };
      }
      this.recentDedupe.set(input.dedupeKey, now);
    }

    // 2. Quiet hours — non-critical notifications are held during the recipient's window.
    if (input.payload.priority !== "critical" && input.localMinute !== undefined && this.quietHoursFor) {
      const q = this.quietHoursFor(input.accountId);
      if (q && inQuietHours(input.localMinute, q)) {
        return { status: "suppressed_quiet_hours", receipts: [] };
      }
    }

    // 3. Fan out to every registered device; one provider failing never blocks the others.
    const targets = this.tokens.targetsFor(input.accountId);
    if (targets.length === 0) return { status: "no_targets", receipts: [] };
    const receipts = await Promise.all(
      targets.map(async (t): Promise<Receipt> => {
        const provider = this.providers.get(t.platform);
        if (!provider) return { deviceId: t.deviceId, platform: t.platform, status: "failed", error: "no provider" };
        try {
          await provider.deliver(t.token, input.payload);
          return { deviceId: t.deviceId, platform: t.platform, status: "delivered" };
        } catch (err) {
          return { deviceId: t.deviceId, platform: t.platform, status: "failed", error: (err as Error).message };
        }
      }),
    );
    return { status: "delivered", receipts };
  }
}
