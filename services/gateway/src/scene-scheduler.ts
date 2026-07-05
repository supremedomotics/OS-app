import { sunTimes } from "@supreme/automations";
import { dueScenes, type SceneSchedule } from "@supreme/scenes";

/**
 * Fires scheduled scenes on the hub. Once a minute it resolves each schedule's trigger (a wall-clock
 * time, or sunrise/sunset±offset using the home's location) and activates the scenes due this minute.
 * De-dupes by minute so a schedule fires at most once per minute even if ticked twice. Schedules +
 * location come from the durable config store; missing location falls back to 06:00/18:00 for solar.
 */
export class SceneScheduler {
  private lastMinute = -1;
  private readonly now: () => Date;

  constructor(
    private readonly opts: {
      getSchedules: () => Promise<SceneSchedule[]>;
      getLocation: () => Promise<{ lat: number; lon: number } | undefined>;
      activate: (sceneId: string) => Promise<void>;
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

    const schedules = await this.opts.getSchedules();
    if (schedules.length === 0) return;

    let sunriseMinute = 6 * 60;
    let sunsetMinute = 18 * 60;
    const loc = await this.opts.getLocation();
    if (loc) {
      const t = sunTimes({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), latitude: loc.lat, longitude: loc.lon });
      // Convert the UTC instants to the hub's LOCAL minute-of-day (getHours() is local).
      sunriseMinute = localMinute(new Date(t.sunrise));
      sunsetMinute = localMinute(new Date(t.sunset));
    }

    const due = dueScenes(schedules, { nowMinute, dayOfWeek: d.getDay(), sunriseMinute, sunsetMinute });
    for (const sceneId of due) {
      try {
        await this.opts.activate(sceneId);
        this.opts.log?.("scheduled scene activated", { sceneId });
      } catch (err) {
        this.opts.log?.("scheduled scene activation failed", { sceneId, error: (err as Error).message });
      }
    }
  }
}

const localMinute = (d: Date) => d.getHours() * 60 + d.getMinutes();
