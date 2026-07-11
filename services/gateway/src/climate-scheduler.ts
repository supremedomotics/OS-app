import { dueClimateEvents, type ClimateScheduleEvent } from "@supreme/automations";

/**
 * Fires scheduled HVAC events on the hub (§ HVAC Detail Page "Schedule" — "These
 * schedules are executed by SupremeOS, not CoolMaster"). Once a minute, resolves which
 * per-device events are due and sends each one as a REAL temperature capability command
 * through the SIL — exactly the same command path the console's own controls use, so a
 * scheduled event and a homeowner tap are indistinguishable to the driver. Mirrors
 * scene-scheduler.ts's shape exactly (minute de-dupe, guarded per-event execution).
 */
export class ClimateScheduler {
  private lastMinute = -1;
  private readonly now: () => Date;

  constructor(
    private readonly opts: {
      getEvents: () => Promise<ClimateScheduleEvent[]>;
      getHolidayDeviceIds: () => Promise<string[]>;
      /** Consume a fired "once" event so it never re-fires (disables it). */
      onOnceFired: (eventId: string) => Promise<void>;
      apply: (deviceId: string, targetC: number, mode: "heat" | "cool" | "auto" | "fan_only", fanSpeed?: string) => Promise<void>;
      now?: () => Date;
      log?: (msg: string, meta?: Record<string, unknown>) => void;
    },
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async tick(): Promise<void> {
    const d = this.now();
    const nowMinute = d.getHours() * 60 + d.getMinutes();
    if (nowMinute === this.lastMinute) return; // already handled this minute
    this.lastMinute = nowMinute;

    const events = await this.opts.getEvents();
    if (events.length === 0) return;
    const holidayDeviceIds = await this.opts.getHolidayDeviceIds();

    const todayIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const due = dueClimateEvents(events, holidayDeviceIds, { nowMinute, dayOfWeek: d.getDay(), todayIso });

    for (const e of due) {
      try {
        await this.opts.apply(e.deviceId, e.targetC, e.mode, e.fanSpeed);
        this.opts.log?.("scheduled climate event applied", { eventId: e.id, deviceId: e.deviceId });
      } catch (err) {
        this.opts.log?.("scheduled climate event failed", { eventId: e.id, deviceId: e.deviceId, error: (err as Error).message });
      }
      if (e.recurrence === "once") {
        try {
          await this.opts.onOnceFired(e.id);
        } catch (err) {
          this.opts.log?.("failed to disable fired one-time climate event", { eventId: e.id, error: (err as Error).message });
        }
      }
    }
  }
}
