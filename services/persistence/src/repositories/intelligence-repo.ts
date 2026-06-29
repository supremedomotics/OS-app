import type { SqlDb } from "../sql-db.js";

/** One row of Supreme Intelligence Engine learning/action history. */
export interface SieHistoryRecord {
  id: string;
  homeId: string;
  ts: string;
  module: string;
  deviceId?: string | null;
  roomId?: string | null;
  zoneId?: string | null;
  ownerUserId?: string | null;
  action: string;
  reason?: string | null;
  automatic: boolean;
  userResponse?: string | null;
  decisionConfidence?: number | null;
  presenceConfidence?: number | null;
  roomVacancyConfidence?: number | null;
  ownershipConfidence?: number | null;
  energyConfidence?: number | null;
  estimatedWatts?: number | null;
  estimatedKwhSaved?: number | null;
  estimatedCostSaved?: number | null;
  currency?: string | null;
  metadata?: Record<string, unknown>;
}

interface Row {
  id: string;
  home_id: string;
  ts: string;
  module: string;
  device_id: string | null;
  room_id: string | null;
  zone_id: string | null;
  owner_user_id: string | null;
  action: string;
  reason: string | null;
  automatic: boolean;
  user_response: string | null;
  decision_confidence: number | null;
  presence_confidence: number | null;
  room_vacancy_confidence: number | null;
  ownership_confidence: number | null;
  energy_confidence: number | null;
  estimated_watts: number | null;
  estimated_kwh_saved: number | null;
  estimated_cost_saved: number | null;
  currency: string | null;
  metadata: Record<string, unknown>;
}

function toRecord(r: Row): SieHistoryRecord {
  return {
    id: r.id,
    homeId: r.home_id,
    ts: r.ts,
    module: r.module,
    deviceId: r.device_id,
    roomId: r.room_id,
    zoneId: r.zone_id,
    ownerUserId: r.owner_user_id,
    action: r.action,
    reason: r.reason,
    automatic: r.automatic,
    userResponse: r.user_response,
    decisionConfidence: num(r.decision_confidence),
    presenceConfidence: num(r.presence_confidence),
    roomVacancyConfidence: num(r.room_vacancy_confidence),
    ownershipConfidence: num(r.ownership_confidence),
    energyConfidence: num(r.energy_confidence),
    estimatedWatts: num(r.estimated_watts),
    estimatedKwhSaved: num(r.estimated_kwh_saved),
    estimatedCostSaved: num(r.estimated_cost_saved),
    currency: r.currency,
    metadata: r.metadata ?? {},
  };
}

const num = (v: number | null): number | null => (v === null || v === undefined ? null : Number(v));

export interface SieSavingsAggregate {
  kwhSaved: number;
  costSaved: number;
  autoActions: number;
  notificationsSent: number;
  notificationsIgnored: number;
  userOff: number;
  keepOn: number;
}

/** Postgres-backed Supreme Intelligence history store (also runs on embedded PGlite in tests). */
export class IntelligenceRepo {
  constructor(private readonly db: SqlDb) {}

  async record(r: SieHistoryRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO sie_history
        (id, home_id, ts, module, device_id, room_id, zone_id, owner_user_id, action, reason, automatic,
         user_response, decision_confidence, presence_confidence, room_vacancy_confidence, ownership_confidence,
         energy_confidence, estimated_watts, estimated_kwh_saved, estimated_cost_saved, currency, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb)`,
      [
        r.id, r.homeId, r.ts, r.module, r.deviceId ?? null, r.roomId ?? null, r.zoneId ?? null, r.ownerUserId ?? null,
        r.action, r.reason ?? null, r.automatic, r.userResponse ?? null, r.decisionConfidence ?? null,
        r.presenceConfidence ?? null, r.roomVacancyConfidence ?? null, r.ownershipConfidence ?? null,
        r.energyConfidence ?? null, r.estimatedWatts ?? null, r.estimatedKwhSaved ?? null, r.estimatedCostSaved ?? null,
        r.currency ?? null, JSON.stringify(r.metadata ?? {}),
      ],
    );
  }

  /** Most-recent-first history, optionally within a time range and/or for one device. */
  async list(homeId: string, opts: { from?: string; to?: string; deviceId?: string; limit?: number } = {}): Promise<SieHistoryRecord[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM sie_history
        WHERE home_id = $1
          AND ($2::text IS NULL OR ts >= $2) AND ($3::text IS NULL OR ts <= $3)
          AND ($4::text IS NULL OR device_id = $4)
        ORDER BY ts DESC LIMIT $5`,
      [homeId, opts.from ?? null, opts.to ?? null, opts.deviceId ?? null, opts.limit ?? 200],
    );
    return rows.map(toRecord);
  }

  /** Savings + interaction tallies over a range, for the reports/dashboard. */
  async aggregate(homeId: string, from?: string, to?: string): Promise<SieSavingsAggregate> {
    const { rows } = await this.db.query<{
      kwh: number | null; cost: number | null; auto: number; notif: number; ignored: number; useroff: number; keepon: number;
    }>(
      `SELECT
         COALESCE(SUM(estimated_kwh_saved), 0)  AS kwh,
         COALESCE(SUM(estimated_cost_saved), 0) AS cost,
         COUNT(*) FILTER (WHERE automatic AND action = 'auto_off')              AS auto,
         COUNT(*) FILTER (WHERE action IN ('notified', 'approval_requested'))    AS notif,
         COUNT(*) FILTER (WHERE action IN ('ignored_today', 'always_ignore'))    AS ignored,
         COUNT(*) FILTER (WHERE action = 'user_off')                            AS useroff,
         COUNT(*) FILTER (WHERE action = 'keep_on')                             AS keepon
       FROM sie_history
       WHERE home_id = $1 AND ($2::text IS NULL OR ts >= $2) AND ($3::text IS NULL OR ts <= $3)`,
      [homeId, from ?? null, to ?? null],
    );
    const r = rows[0]!;
    return {
      kwhSaved: Number(r.kwh ?? 0),
      costSaved: Number(r.cost ?? 0),
      autoActions: Number(r.auto ?? 0),
      notificationsSent: Number(r.notif ?? 0),
      notificationsIgnored: Number(r.ignored ?? 0),
      userOff: Number(r.useroff ?? 0),
      keepOn: Number(r.keepon ?? 0),
    };
  }

  /** Devices that triggered the most suggestions (the "top forgotten devices"). */
  async topDevices(homeId: string, from?: string, to?: string, limit = 5): Promise<{ deviceId: string; events: number; kwhSaved: number }[]> {
    const { rows } = await this.db.query<{ device_id: string; events: number; kwh: number | null }>(
      `SELECT device_id, COUNT(*) AS events, COALESCE(SUM(estimated_kwh_saved), 0) AS kwh
         FROM sie_history
        WHERE home_id = $1 AND device_id IS NOT NULL
          AND ($2::text IS NULL OR ts >= $2) AND ($3::text IS NULL OR ts <= $3)
        GROUP BY device_id ORDER BY events DESC LIMIT $4`,
      [homeId, from ?? null, to ?? null, limit],
    );
    return rows.map((r) => ({ deviceId: r.device_id, events: Number(r.events), kwhSaved: Number(r.kwh ?? 0) }));
  }
}
