import {
  newId,
  type CapabilityState,
  type DeviceId,
  type HomeId,
  type RoomId,
} from "@supreme/domain-model";
import type { SqlDb } from "@supreme/persistence";
import type { ConsumptionSample } from "./tariff.js";

// Tariff-aware energy cost engine (pure; turns consumption into money + budget projection).
export {
  loadShiftDecision,
  peakRate,
  type LoadShiftDecision,
  type LoadShiftOptions,
} from "./load-shift.js";
export {
  resolveRate,
  resolveRateAsync,
  COUNTRY_RATES,
  RateError,
  type ProviderQuery,
  type ResolvedRate,
  type ElectricityRate,
  type RateFetcher,
} from "./rates.js";
export {
  bucketCostHistory,
  applyGroupCost,
  compareGroupCost,
  type HistoryBucket,
  type DailyEnergy,
  type CostBucket,
  type GroupConsumption,
  type GroupCost,
  type GroupDelta,
} from "./cost-history.js";
export { costHistoryToCsv, costBreakdownToCsv } from "./cost-export.js";
export {
  computeEnergyCost,
  budgetStatus,
  TariffError,
  type Tariff,
  type TariffPeriod,
  type ConsumptionSample,
  type CostBreakdown,
  type BudgetStatus,
  type DayType,
} from "./tariff.js";

/**
 * Energy & telemetry analytics (§16). Ingests numeric measures from normalized
 * device state (sensors, climate) into a time-series table and answers aggregate
 * questions: per-measure totals, top consumers, and per-hour series. Backed by the
 * SqlDb seam, so it runs on the hub's Postgres and on embedded Postgres in tests.
 */
export interface SampleInput {
  homeId: HomeId;
  deviceId: DeviceId;
  roomId: RoomId | null;
  measure: string;
  value: number;
  unit: string;
  ts?: string;
}

export interface MeasureSummary {
  measure: string;
  total: number;
  average: number;
  count: number;
  unit: string;
}

export interface DeviceConsumption {
  deviceId: string;
  total: number;
  unit: string;
}

export class AnalyticsService {
  constructor(private readonly db: SqlDb) {}

  /** Record one telemetry sample. */
  async record(input: SampleInput): Promise<void> {
    await this.db.query(
      `INSERT INTO energy_samples (id, home_id, device_id, room_id, measure, value, unit, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        newId("sample"),
        input.homeId,
        input.deviceId,
        input.roomId,
        input.measure,
        input.value,
        input.unit,
        input.ts ?? new Date().toISOString(),
      ],
    );
  }

  /**
   * Ingest a normalized capability state into telemetry. Sensors record their
   * measured value; climate records ambient temperature. Other capabilities are
   * ignored (no numeric telemetry).
   */
  async ingestState(
    ctx: { homeId: HomeId; deviceId: DeviceId; roomId: RoomId | null },
    state: CapabilityState,
  ): Promise<void> {
    if (state.kind === "sensor") {
      await this.record({ ...ctx, measure: state.measure, value: state.value, unit: state.unit });
    } else if (state.kind === "temperature") {
      await this.record({ ...ctx, measure: "temperature", value: state.ambientC, unit: "°C" });
    }
  }

  /** Per-measure totals over an optional time range. */
  async summary(homeId: HomeId, from?: string, to?: string): Promise<MeasureSummary[]> {
    const { rows } = await this.db.query<{
      measure: string;
      total: number;
      average: number;
      count: number;
      unit: string;
    }>(
      `SELECT measure, SUM(value) AS total, AVG(value) AS average, COUNT(*) AS count, MAX(unit) AS unit
         FROM energy_samples
        WHERE home_id = $1 AND ($2::text IS NULL OR ts >= $2) AND ($3::text IS NULL OR ts <= $3)
        GROUP BY measure ORDER BY measure`,
      [homeId, from ?? null, to ?? null],
    );
    return rows.map((r) => ({
      measure: r.measure,
      total: Number(r.total),
      average: Number(r.average),
      count: Number(r.count),
      unit: r.unit,
    }));
  }

  /** Top consuming devices for a measure (e.g. 'energy'), highest first. */
  async topConsumers(homeId: HomeId, measure: string, limit = 5): Promise<DeviceConsumption[]> {
    const { rows } = await this.db.query<{ device_id: string; total: number; unit: string }>(
      `SELECT device_id, SUM(value) AS total, MAX(unit) AS unit
         FROM energy_samples WHERE home_id = $1 AND measure = $2
        GROUP BY device_id ORDER BY total DESC LIMIT $3`,
      [homeId, measure, limit],
    );
    return rows.map((r) => ({ deviceId: r.device_id, total: Number(r.total), unit: r.unit }));
  }

  /** Per-hour buckets for a device measure (sum + average per ISO hour). */
  async hourlySeries(
    deviceId: DeviceId,
    measure: string,
    from?: string,
    to?: string,
  ): Promise<{ hour: string; total: number; average: number }[]> {
    const { rows } = await this.db.query<{ hour: string; total: number; average: number }>(
      `SELECT substr(ts, 1, 13) AS hour, SUM(value) AS total, AVG(value) AS average
         FROM energy_samples
        WHERE device_id = $1 AND measure = $2
          AND ($3::text IS NULL OR ts >= $3) AND ($4::text IS NULL OR ts <= $4)
        GROUP BY substr(ts, 1, 13) ORDER BY hour`,
      [deviceId, measure, from ?? null, to ?? null],
    );
    return rows.map((r) => ({ hour: r.hour, total: Number(r.total), average: Number(r.average) }));
  }

  /**
   * Home-wide hourly energy (kWh) as ConsumptionSamples the tariff cost engine consumes. The hour
   * bucket is normalized to a parseable ISO instant (`…THH:00:00Z`). Timestamps are the home's local
   * clock (as recorded), so tariff hours line up with the wall clock.
   */
  async hourlyEnergy(homeId: HomeId, from?: string, to?: string): Promise<ConsumptionSample[]> {
    const { rows } = await this.db.query<{ ts: string; kwh: number }>(
      `SELECT substr(ts, 1, 13) || ':00:00Z' AS ts, SUM(value) AS kwh
         FROM energy_samples
        WHERE home_id = $1 AND measure = 'energy'
          AND ($2::text IS NULL OR ts >= $2) AND ($3::text IS NULL OR ts <= $3)
        GROUP BY substr(ts, 1, 13) ORDER BY 1`,
      [homeId, from ?? null, to ?? null],
    );
    return rows.map((r) => ({ ts: r.ts, kwh: Number(r.kwh) }));
  }

  /** Per-device or per-room energy (kWh) over a range — for the cost breakdown. */
  async energyByGroup(homeId: HomeId, groupBy: "device" | "room", from?: string, to?: string): Promise<{ key: string; kwh: number }[]> {
    const col = groupBy === "room" ? "COALESCE(room_id, 'unassigned')" : "device_id";
    const { rows } = await this.db.query<{ key: string; kwh: number }>(
      `SELECT ${col} AS key, SUM(value) AS kwh
         FROM energy_samples
        WHERE home_id = $1 AND measure = 'energy'
          AND ($2::text IS NULL OR ts >= $2) AND ($3::text IS NULL OR ts <= $3)
        GROUP BY ${col} ORDER BY kwh DESC`,
      [homeId, from ?? null, to ?? null],
    );
    return rows.map((r) => ({ key: r.key, kwh: Number(r.kwh) }));
  }

  /** Per-day energy (kWh) for the home or a single device — rolled into history buckets by the caller. */
  async energyDailySeries(homeId: HomeId, from?: string, to?: string, deviceId?: string): Promise<{ day: string; kwh: number }[]> {
    const { rows } = await this.db.query<{ day: string; kwh: number }>(
      `SELECT substr(ts, 1, 10) AS day, SUM(value) AS kwh
         FROM energy_samples
        WHERE home_id = $1 AND measure = 'energy'
          AND ($2::text IS NULL OR device_id = $2)
          AND ($3::text IS NULL OR ts >= $3) AND ($4::text IS NULL OR ts <= $4)
        GROUP BY substr(ts, 1, 10) ORDER BY 1`,
      [homeId, deviceId ?? null, from ?? null, to ?? null],
    );
    return rows.map((r) => ({ day: r.day, kwh: Number(r.kwh) }));
  }
}
