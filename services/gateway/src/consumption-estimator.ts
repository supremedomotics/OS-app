/**
 * Estimated consumption for non-metered devices (§16). Most lights/appliances don't report power, so
 * per-device cost would be empty for them. If the owner gives a device its rated wattage, the hub
 * estimates energy from on-time: each minute a metered device is ON it accrues `watts/1000/60` kWh,
 * flushed periodically as an `energy` sample (tagged estimated) so it flows into the same cost
 * breakdown + history as real meter data. Runs on the shared minute tick.
 */
export class ConsumptionEstimator {
  private readonly acc = new Map<string, number>(); // deviceId → kWh accrued since the last flush
  private ticks = 0;
  private readonly flushEvery: number;

  constructor(
    private readonly opts: {
      /** deviceId → rated watts. */
      getWatts: () => Promise<Record<string, number>>;
      isOn: (deviceId: string) => Promise<boolean>;
      roomOf: (deviceId: string) => Promise<string | null>;
      record: (deviceId: string, roomId: string | null, kwh: number) => Promise<void>;
      /** Flush accrued energy every N ticks (minutes). Default 60 → one row/device/hour. */
      flushEveryTicks?: number;
      log?: (msg: string, meta?: Record<string, unknown>) => void;
    },
  ) {
    this.flushEvery = opts.flushEveryTicks ?? 60;
  }

  /** Called from the hub minute tick: accrue a minute of energy for each metered, on device. */
  async tick(): Promise<void> {
    const watts = await this.opts.getWatts();
    const ids = Object.keys(watts);
    if (ids.length === 0) return;
    for (const id of ids) {
      const w = watts[id]!;
      if (w > 0 && (await this.opts.isOn(id))) {
        this.acc.set(id, (this.acc.get(id) ?? 0) + w / 1000 / 60); // kWh for one minute
      }
    }
    if (++this.ticks >= this.flushEvery) {
      await this.flush();
      this.ticks = 0;
    }
  }

  /** Persist accrued estimates as energy samples and reset the accumulator. */
  async flush(): Promise<void> {
    for (const [id, kwh] of [...this.acc.entries()]) {
      if (kwh <= 0) continue;
      try {
        await this.opts.record(id, await this.opts.roomOf(id), Math.round(kwh * 1000) / 1000);
      } catch (err) {
        this.opts.log?.("consumption estimate flush failed", { deviceId: id, error: (err as Error).message });
      }
    }
    this.acc.clear();
  }
}
