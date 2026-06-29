/**
 * Adaptive ventilation (§16) — a comfort/health feature. Watch an air-quality sensor (CO₂ ppm, or a
 * VOC/PM index) and run a fan / HVAC-vent when the air gets stale, stopping once it clears. Uses
 * HYSTERESIS — turn ON above `highThreshold`, OFF below `lowThreshold` — so it doesn't flap around a
 * single setpoint. Pure decision (`ventilationDecision`) + a thin runner that reads the sensor and
 * toggles the fan only on a change. Config (sensor, fan, thresholds) comes from the durable store.
 */

export interface VentilationConfig {
  /** Device id of the air-quality sensor (a `sensor`-capability device). */
  sensorDeviceId: string;
  /** Device id of the fan / ventilation device to drive (onoff). */
  fanDeviceId: string;
  /** Turn the fan ON when the reading rises to/above this. */
  highThreshold: number;
  /** Turn the fan OFF when the reading falls to/below this. */
  lowThreshold: number;
}

export class VentilationError extends Error {}

export function validateVentilationConfig(c: unknown): VentilationConfig {
  const o = c as Partial<VentilationConfig>;
  if (!o || typeof o.sensorDeviceId !== "string" || !o.sensorDeviceId) throw new VentilationError("sensorDeviceId is required");
  if (typeof o.fanDeviceId !== "string" || !o.fanDeviceId) throw new VentilationError("fanDeviceId is required");
  if (typeof o.highThreshold !== "number" || typeof o.lowThreshold !== "number") throw new VentilationError("highThreshold and lowThreshold must be numbers");
  if (o.lowThreshold >= o.highThreshold) throw new VentilationError("lowThreshold must be below highThreshold (hysteresis)");
  return { sensorDeviceId: o.sensorDeviceId, fanDeviceId: o.fanDeviceId, highThreshold: o.highThreshold, lowThreshold: o.lowThreshold };
}

/**
 * The next fan state given the current reading, thresholds, and whether the fan is currently on.
 * Returns true (run), false (stop), or null (no change — reading is between the thresholds).
 */
export function ventilationDecision(reading: number, cfg: { highThreshold: number; lowThreshold: number }, fanOn: boolean): boolean | null {
  if (reading >= cfg.highThreshold) return fanOn ? null : true;
  if (reading <= cfg.lowThreshold) return fanOn ? false : null;
  return null; // in the hysteresis band → hold
}

export class VentilationRunner {
  private fanOn = false;

  constructor(
    private readonly opts: {
      getConfig: () => Promise<VentilationConfig | undefined>;
      readSensor: (deviceId: string) => Promise<number | undefined>;
      setFan: (deviceId: string, on: boolean) => Promise<void>;
      log?: (msg: string, meta?: Record<string, unknown>) => void;
    },
  ) {}

  async tick(): Promise<void> {
    const cfg = await this.opts.getConfig();
    if (!cfg) return;
    const reading = await this.opts.readSensor(cfg.sensorDeviceId);
    if (reading === undefined) return;
    const next = ventilationDecision(reading, cfg, this.fanOn);
    if (next === null) return;
    try {
      await this.opts.setFan(cfg.fanDeviceId, next);
      this.fanOn = next;
      this.opts.log?.("ventilation", { reading, fanOn: next });
    } catch (err) {
      this.opts.log?.("ventilation apply failed", { error: (err as Error).message });
    }
  }

  get currentFanState(): boolean {
    return this.fanOn;
  }
}
