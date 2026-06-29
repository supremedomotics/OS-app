import { loadShiftDecision, type Tariff } from "@supreme/analytics";

/**
 * Applies peak-aware load shifting on the hub (§16): during the priciest tariff period it pauses the
 * homeowner's nominated DEFERRABLE loads (EV charger, pool pump, water heater) and resumes them when
 * the rate drops. It only RESUMES devices it itself paused, so a load the owner switched off stays
 * off. The decision is pure (@supreme/analytics loadShiftDecision); this is the thin stateful runner.
 */
export class LoadShiftRunner {
  private readonly pausedByUs = new Set<string>();
  private readonly now: () => Date;

  constructor(
    private readonly opts: {
      getTariff: () => Promise<Tariff | undefined>;
      getDeferrableDeviceIds: () => Promise<string[]>;
      getCeiling: () => Promise<number | undefined>;
      setDeviceOn: (deviceId: string, on: boolean) => Promise<void>;
      now?: () => Date;
      log?: (msg: string, meta?: Record<string, unknown>) => void;
    },
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async tick(): Promise<void> {
    const tariff = await this.opts.getTariff();
    const devices = await this.opts.getDeferrableDeviceIds();
    const deferrable = new Set(devices);
    // Never strand a load we paused: if the tariff is gone or a device left the deferrable list,
    // resume it now (don't wait for an off-peak transition that may not come).
    for (const id of [...this.pausedByUs]) {
      if (!tariff || !deferrable.has(id)) {
        await this.apply(id, true);
        this.pausedByUs.delete(id);
      }
    }
    if (!tariff || devices.length === 0) return;
    const d = this.now();
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const ceiling = await this.opts.getCeiling();
    const decision = loadShiftDecision(tariff, d.getHours() * 60 + d.getMinutes(), weekend, ceiling !== undefined ? { maxRunRatePerKwh: ceiling } : {});

    if (!decision.allowRun) {
      for (const id of devices) {
        if (this.pausedByUs.has(id)) continue;
        await this.apply(id, false);
        this.pausedByUs.add(id);
      }
    } else {
      for (const id of [...this.pausedByUs]) {
        await this.apply(id, true);
        this.pausedByUs.delete(id);
      }
    }
  }

  /** Devices currently paused for cost reasons (inspection/UI). */
  get pausedDevices(): string[] {
    return [...this.pausedByUs];
  }

  private async apply(deviceId: string, on: boolean): Promise<void> {
    try {
      await this.opts.setDeviceOn(deviceId, on);
      this.opts.log?.("load shift", { deviceId, on });
    } catch (err) {
      this.opts.log?.("load shift apply failed", { deviceId, error: (err as Error).message });
    }
  }
}
