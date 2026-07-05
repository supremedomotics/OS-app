/**
 * @supreme/cloud-persistence — durable Postgres stores for the Supreme Cloud control plane.
 * Mirrors the hub's persistence pattern: a thin {@link SqlDb} seam (production Postgres or
 * embedded PGlite), idempotent migrations, and repositories that implement the service store
 * seams — so the cloud services run unchanged on top of a real database.
 */
export { PgDb, PgliteDb, type SqlDb } from "./sql-db.js";
export { migrateCloud } from "./migrate.js";
export { PgHubRegistryStore } from "./hub-registry-store.js";
export { PgIdentityStore } from "./identity-store.js";
export { PgDeviceStore } from "./device-store.js";
export { PgAuthnStore } from "./authn-store.js";

import { migrateCloud } from "./migrate.js";
import { PgDb, PgliteDb, type SqlDb } from "./sql-db.js";
import { PgHubRegistryStore } from "./hub-registry-store.js";
import { PgIdentityStore } from "./identity-store.js";
import { PgDeviceStore } from "./device-store.js";
import { PgAuthnStore } from "./authn-store.js";

export interface CloudPersistence {
  db: SqlDb;
  hubRegistry: PgHubRegistryStore;
  identity: PgIdentityStore;
  devices: PgDeviceStore;
  authn: PgAuthnStore;
}

/**
 * Build the cloud persistence layer. With a `connectionString` it uses production Postgres;
 * without one it spins up embedded PGlite (tests / zero-dependency local). Migrations run on
 * connect, idempotently. Every service store is Postgres-backed so accounts, sessions, devices,
 * and the hub ownership graph all survive a restart.
 */
export async function createCloudPersistence(opts: { connectionString?: string } = {}): Promise<CloudPersistence> {
  const db: SqlDb = opts.connectionString
    ? await PgDb.connect(opts.connectionString)
    : await PgliteDb.create();
  await migrateCloud(db);
  return {
    db,
    hubRegistry: new PgHubRegistryStore(db),
    identity: new PgIdentityStore(db),
    devices: new PgDeviceStore(db),
    authn: new PgAuthnStore(db),
  };
}
