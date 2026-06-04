import type { DriverId, HomeId, InstalledDriver } from "@supreme/domain-model";
import type { IInstalledDriverStore } from "@supreme/drivers";
import type { SqlDb } from "../sql-db.js";

interface DriverRow {
  id: string;
  home_id: string;
  key: string;
  version: string;
  channel: string;
  category: string;
  installed_at: string;
  enabled: boolean;
  status: string;
  config: Record<string, unknown>;
}

function rowToDriver(r: DriverRow): InstalledDriver {
  return {
    id: r.id as DriverId,
    homeId: r.home_id as HomeId,
    key: r.key,
    version: r.version,
    channel: r.channel as InstalledDriver["channel"],
    category: r.category as InstalledDriver["category"],
    installedAt: r.installed_at,
    enabled: r.enabled,
    status: r.status as InstalledDriver["status"],
    config: r.config,
  };
}

/** Postgres-backed {@link IInstalledDriverStore}. */
export class InstalledDriverRepo implements IInstalledDriverStore {
  constructor(private readonly db: SqlDb) {}

  async list(): Promise<InstalledDriver[]> {
    const { rows } = await this.db.query<DriverRow>("SELECT * FROM installed_drivers ORDER BY key");
    return rows.map(rowToDriver);
  }
  async get(id: DriverId): Promise<InstalledDriver | null> {
    const { rows } = await this.db.query<DriverRow>("SELECT * FROM installed_drivers WHERE id=$1", [id]);
    return rows[0] ? rowToDriver(rows[0]) : null;
  }
  async getByKey(key: string): Promise<InstalledDriver | null> {
    const { rows } = await this.db.query<DriverRow>("SELECT * FROM installed_drivers WHERE key=$1", [key]);
    return rows[0] ? rowToDriver(rows[0]) : null;
  }
  async put(driver: InstalledDriver): Promise<void> {
    await this.db.query(
      `INSERT INTO installed_drivers (id, home_id, key, version, channel, category, installed_at, enabled, status, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         version=$4, channel=$5, category=$6, enabled=$8, status=$9, config=$10::jsonb`,
      [
        driver.id, driver.homeId, driver.key, driver.version, driver.channel,
        driver.category, driver.installedAt, driver.enabled, driver.status,
        JSON.stringify(driver.config),
      ],
    );
  }
  async remove(id: DriverId): Promise<void> {
    await this.db.query("DELETE FROM installed_drivers WHERE id=$1", [id]);
  }
}
