/**
 * @supreme/persistence — the Supreme system of record (§5).
 *
 * Provides Postgres-backed implementations of every service store interface,
 * tested in-process against embedded Postgres (PGlite). The hub runs node-postgres
 * against the Compose Postgres; the same SQL and migrations serve both.
 */
import type { IIdentityStore } from "@supreme/identity";
import type { IHomeStore } from "@supreme/home";
import type { ISceneStore } from "@supreme/scenes";
import type { IGrantStore } from "@supreme/permissions";
import type { INotificationStore } from "@supreme/notifications";
import type { IInstalledDriverStore } from "@supreme/drivers";
import { migrate } from "./migrate.js";
import { PgDb, PgliteDb, type SqlDb } from "./sql-db.js";
import { IdentityRepo } from "./repositories/identity-repo.js";
import { HomeRepo } from "./repositories/home-repo.js";
import { SceneRepo } from "./repositories/scene-repo.js";
import { GrantRepo } from "./repositories/grant-repo.js";
import { NotificationRepo } from "./repositories/notification-repo.js";
import { InstalledDriverRepo } from "./repositories/driver-repo.js";

export { migrate } from "./migrate.js";
export { PgDb, PgliteDb, type SqlDb } from "./sql-db.js";
export { IdentityRepo } from "./repositories/identity-repo.js";
export { HomeRepo } from "./repositories/home-repo.js";
export { SceneRepo } from "./repositories/scene-repo.js";
export { GrantRepo } from "./repositories/grant-repo.js";
export { NotificationRepo } from "./repositories/notification-repo.js";
export { InstalledDriverRepo } from "./repositories/driver-repo.js";

/** The full set of persisted stores, ready to inject into the domain services. */
export interface PersistenceStores {
  db: SqlDb;
  identity: IIdentityStore;
  home: IHomeStore;
  scenes: ISceneStore;
  grants: IGrantStore;
  notifications: INotificationStore;
  drivers: IInstalledDriverStore;
}

/** Build store implementations over an already-migrated {@link SqlDb}. */
export function buildStores(db: SqlDb): Omit<PersistenceStores, "db"> {
  return {
    identity: new IdentityRepo(db),
    home: new HomeRepo(db),
    scenes: new SceneRepo(db),
    grants: new GrantRepo(db),
    notifications: new NotificationRepo(db),
    drivers: new InstalledDriverRepo(db),
  };
}

/**
 * Connect to the hub database, run migrations, and return the stores. Pass a
 * Postgres connection string for production; omit it to use embedded PGlite
 * (optionally persisted to `pgliteDir`).
 */
export async function createPersistence(opts: {
  connectionString?: string;
  pgliteDir?: string;
}): Promise<PersistenceStores> {
  const db: SqlDb = opts.connectionString
    ? await PgDb.connect(opts.connectionString)
    : await PgliteDb.create(opts.pgliteDir);
  await migrate(db);
  return { db, ...buildStores(db) };
}
