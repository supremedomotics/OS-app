import { occupancyEventsAt, type OccupancyEvent } from "@supreme/security";

/**
 * Drives an occupancy (vacation) simulation plan on the hub: the hub's once-a-minute tick calls
 * {@link tickNow}, which applies the on/off events due at the current local minute (toggling lights
 * so the home looks lived-in). The plan is pure (see @supreme/security planOccupancy); this is the
 * thin, in-memory scheduler around it. State is transient — re-enable after a reboot. It does NOT
 * own a timer: it rides the shared minute tick like the other runners, with per-minute de-dup so an
 * event fires at most once even if ticked twice in the same minute.
 */
export class OccupancyRunner {
  private plan: OccupancyEvent[] = [];
  private enabled = false;
  private lastMinute = -1;
  private readonly command: (deviceId: string, on: boolean) => Promise<void>;
  private readonly now: () => Date;

  constructor(opts: { command: (deviceId: string, on: boolean) => Promise<void>; now?: () => Date }) {
    this.command = opts.command;
    this.now = opts.now ?? (() => new Date());
  }

  /** Enable (or replace) the simulation with a plan. */
  start(plan: OccupancyEvent[]): void {
    this.plan = plan;
    this.enabled = true;
    this.lastMinute = -1;
  }

  stop(): void {
    this.enabled = false;
    this.plan = [];
  }

  get running(): boolean {
    return this.enabled;
  }

  preview(): OccupancyEvent[] {
    return this.plan;
  }

  /** Called from the hub minute tick: applies the events due at the current local minute, once. */
  async tickNow(): Promise<void> {
    if (!this.enabled) return;
    const d = this.now();
    const minute = d.getHours() * 60 + d.getMinutes();
    if (minute === this.lastMinute) return; // already handled this minute
    this.lastMinute = minute;
    await this.tick(minute);
  }

  /** Apply the events due at a minute-of-day (exposed for deterministic testing). */
  async tick(minuteOfDay: number): Promise<void> {
    for (const e of occupancyEventsAt(this.plan, minuteOfDay)) {
      await this.command(e.deviceId, e.action === "on");
    }
  }
}
