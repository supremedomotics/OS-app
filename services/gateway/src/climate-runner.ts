import { climateSetpointAt, type ClimateProgram } from "@supreme/automations";

/**
 * Runs a climate program on the hub: once a minute it computes the scheduled setpoint for now (the
 * weekday/weekend block holding at this minute) and, WHEN IT CHANGES, pushes it to the home's climate
 * devices. Acting only on change means a homeowner's manual override between blocks isn't stomped
 * every minute — the program nudges at block boundaries, like a programmable thermostat. The program
 * comes from the durable config store; absent → the runner does nothing.
 */
export class ClimateProgramRunner {
  private lastApplied: number | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly opts: {
      getProgram: () => Promise<ClimateProgram | undefined>;
      applySetpoint: (targetC: number) => Promise<void>;
      now?: () => Date;
      log?: (msg: string, meta?: Record<string, unknown>) => void;
    },
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async tick(): Promise<void> {
    const program = await this.opts.getProgram();
    if (!program) return;
    const d = this.now();
    const dayType = d.getDay() === 0 || d.getDay() === 6 ? "weekend" : "weekday";
    let target: number;
    try {
      target = climateSetpointAt(program, dayType, d.getHours() * 60 + d.getMinutes());
    } catch (err) {
      this.opts.log?.("invalid climate program — skipping", { error: (err as Error).message });
      return;
    }
    if (target === this.lastApplied) return; // only act when the scheduled setpoint changes
    this.lastApplied = target;
    try {
      await this.opts.applySetpoint(target);
      this.opts.log?.("climate program applied setpoint", { targetC: target });
    } catch (err) {
      this.opts.log?.("climate setpoint apply failed", { error: (err as Error).message });
    }
  }

  /** Test/inspection helper. */
  get lastSetpoint(): number | null {
    return this.lastApplied;
  }
}
