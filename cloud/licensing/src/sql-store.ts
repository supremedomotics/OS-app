import type { ILicenseRecordStore, LicenseRecord, LicenseRecordStatus } from "./dealer-licensing.js";

/**
 * Postgres-backed {@link ILicenseRecordStore} so the dealer's issuance/activation ledger
 * survives a restart instead of living only in process memory. Kept decoupled from the hub's
 * `@supreme/persistence` package (licensing is a separate cloud service) by depending only on a
 * minimal SQL executor — the cloud deploy passes a node-postgres adapter, tests pass PGlite. Run
 * {@link init} once at startup. Mirrors the fleet service's store seam.
 */
export interface LicensingSqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}

export const LICENSING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dealer_license_records (
  id            TEXT PRIMARY KEY,
  dealer_org_id TEXT NOT NULL,
  home_id       TEXT NOT NULL,
  sku           TEXT NOT NULL,
  features      TEXT NOT NULL,
  seats         INTEGER NOT NULL,
  issued_at     TEXT NOT NULL,
  expires_at    TEXT,
  status        TEXT NOT NULL,
  activated_at  TEXT,
  supersedes    TEXT
);
CREATE INDEX IF NOT EXISTS dealer_license_records_org_idx ON dealer_license_records (dealer_org_id);
`;

interface RecordRow {
  id: string;
  dealer_org_id: string;
  home_id: string;
  sku: string;
  features: string;
  seats: number;
  issued_at: string;
  expires_at: string | null;
  status: string;
  activated_at: string | null;
  supersedes: string | null;
}

function rowToRecord(r: RecordRow): LicenseRecord {
  return {
    id: r.id,
    dealerOrgId: r.dealer_org_id,
    homeId: r.home_id,
    sku: r.sku,
    features: JSON.parse(r.features) as string[],
    seats: Number(r.seats),
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    status: r.status as LicenseRecordStatus,
    activatedAt: r.activated_at,
    supersedes: r.supersedes,
  };
}

export class SqlLicenseRecordStore implements ILicenseRecordStore {
  constructor(private readonly db: LicensingSqlExecutor) {}

  /** Create the table if it doesn't exist. Call once before serving. */
  async init(): Promise<void> {
    await this.db.exec(LICENSING_SCHEMA_SQL);
  }

  async put(record: LicenseRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO dealer_license_records
         (id, dealer_org_id, home_id, sku, features, seats, issued_at, expires_at, status, activated_at, supersedes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id)
       DO UPDATE SET dealer_org_id=$2, home_id=$3, sku=$4, features=$5, seats=$6,
         issued_at=$7, expires_at=$8, status=$9, activated_at=$10, supersedes=$11`,
      [
        record.id,
        record.dealerOrgId,
        record.homeId,
        record.sku,
        JSON.stringify(record.features),
        record.seats,
        record.issuedAt,
        record.expiresAt,
        record.status,
        record.activatedAt,
        record.supersedes,
      ],
    );
  }

  async get(id: string): Promise<LicenseRecord | null> {
    const { rows } = await this.db.query<RecordRow>("SELECT * FROM dealer_license_records WHERE id=$1", [id]);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async list(dealerOrgId: string): Promise<LicenseRecord[]> {
    const { rows } = await this.db.query<RecordRow>(
      "SELECT * FROM dealer_license_records WHERE dealer_org_id=$1 ORDER BY issued_at DESC",
      [dealerOrgId],
    );
    return rows.map(rowToRecord);
  }
}
