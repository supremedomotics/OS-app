import { occupancyEventsAt, type OccupancyEvent } from "@supreme/security";

/**
 * Drives an occupancy (vacation) simulation plan on the hub: once a minute it applies the on/off
 * events due at the current local minute, toggling lights so the home looks lived-in. The plan is
 * pure (see @supreme/security planOccupancy); this is the thin, in-memory scheduler around it. State
 * is intentionally transient — re-enable after a reboot.
 */
export class OccupancyRunner {
  private plan: OccupancyEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly command: (deviceId: string, on: boolean) => Promise<void>;
  private readonly now: () => Date;

  constructor(opts: { command: (deviceId: string, on: boolean) => Promise<void>; now?: () => Date }) {
    this.command = opts.command;
    this.now = opts.now ?? (() => new Date());
  }

  /** Start (or replace) the simulation with a plan; applies events once a minute. */
  start(plan: OccupancyEvent[]): void {
    this.plan = plan;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.tickNow(), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.plan = [];
  }

  get running(): boolean {
    return this.timer !== null;
  }

  preview(): OccupancyEvent[] {
    return this.plan;
  }

  private async tickNow(): Promise<void> {
    const d = this.now();
    await this.tick(d.getHours() * 60 + d.getMinutes());
  }

  /** Apply the events due at a minute-of-day (exposed for deterministic testing). */
  async tick(minuteOfDay: number): Promise<void> {
    for (const e of occupancyEventsAt(this.plan, minuteOfDay)) {
      await this.command(e.deviceId, e.action === "on");
    }
  }
}
