/**
 * @supreme/persistence — the Supreme system of record (§5).
 *
 * Provides Postgres-backed implementations of every service store interface,
 * tested in-process against embedded Postgres (PGlite). The hub runs node-postgres
 * against the Compose Postgres; the same SQL and migrations serve both.
 */
import type { IIdentityStore, ISessionStore } from "@supreme/identity";
import type { IHomeStore, IConfigStore } from "@supreme/home";
import type { ISceneStore } from "@supreme/scenes";
import type { IGrantStore } from "@supreme/permissions";
import type { INotificationStore } from "@supreme/notifications";
import type { IInstalledDriverStore } from "@supreme/drivers";
import type { IAutomationStore } from "@supreme/automations";
import type { ISecurityStore } from "@supreme/security";
import type { IProtocolBindingStore } from "@supreme/integration-layer";
import type { IPushTokenStore } from "@supreme/notifications";
import type { IMigrationPolicyStore } from "@supreme/integration-layer";
import type { IBackupStore } from "./repositories/backup-repo.js";
import { migrate } from "./migrate.js";
import { PgDb, PgliteDb, type SqlDb } from "./sql-db.js";
import { IdentityRepo } from "./repositories/identity-repo.js";
import { HomeRepo } from "./repositories/home-repo.js";
import { SceneRepo } from "./repositories/scene-repo.js";
import { GrantRepo } from "./repositories/grant-repo.js";
import { NotificationRepo } from "./repositories/notification-repo.js";
import { InstalledDriverRepo } from "./repositories/driver-repo.js";
import { AutomationRepo } from "./repositories/automation-repo.js";
import { SessionRepo } from "./repositories/session-repo.js";
import { SecurityRepo } from "./repositories/security-repo.js";
import { ConfigRepo } from "./repositories/config-repo.js";
import { ProtocolBindingRepo } from "./repositories/protocol-binding-repo.js";
import { PushTokenRepo } from "./repositories/push-token-repo.js";
import { MigrationPolicyRepo } from "./repositories/migration-policy-repo.js";
import { BackupRepo } from "./repositories/backup-repo.js";
import { PendingDeviceRepo, type IPendingDeviceStore } from "./repositories/pending-device-repo.js";

export { migrate } from "./migrate.js";
export { PgDb, PgliteDb, type SqlDb } from "./sql-db.js";
export { IdentityRepo } from "./repositories/identity-repo.js";
export { HomeRepo } from "./repositories/home-repo.js";
export { SceneRepo } from "./repositories/scene-repo.js";
export { GrantRepo } from "./repositories/grant-repo.js";
export { NotificationRepo } from "./repositories/notification-repo.js";
export { InstalledDriverRepo } from "./repositories/driver-repo.js";
export { AutomationRepo } from "./repositories/automation-repo.js";
export { SessionRepo } from "./repositories/session-repo.js";
export { SecurityRepo } from "./repositories/security-repo.js";
export { ConfigRepo } from "./repositories/config-repo.js";
export {
  BackupRepo,
  type IBackupStore,
  type BackupRecord,
  type BackupRecordMeta,
} from "./repositories/backup-repo.js";
export {
  PendingDeviceRepo,
  type IPendingDeviceStore,
  type PendingDeviceRecord,
  type StagePendingInput,
} from "./repositories/pending-device-repo.js";
export { ProtocolBindingRepo } from "./repositories/protocol-binding-repo.js";
export { PushTokenRepo } from "./repositories/push-token-repo.js";
export { MigrationPolicyRepo } from "./repositories/migration-policy-repo.js";
export { IntelligenceRepo, type SieHistoryRecord, type SieSavingsAggregate } from "./repositories/intelligence-repo.js";

/** The full set of persisted stores, ready to inject into the domain services. */
export interface PersistenceStores {
  db: SqlDb;
  identity: IIdentityStore;
  sessions: ISessionStore;
  home: IHomeStore;
  scenes: ISceneStore;
  grants: IGrantStore;
  notifications: INotificationStore;
  drivers: IInstalledDriverStore;
  automations: IAutomationStore;
  security: ISecurityStore;
  protocolBindings: IProtocolBindingStore;
  pushTokens: IPushTokenStore;
  migrationPolicy: IMigrationPolicyStore;
  config: IConfigStore;
  backups: IBackupStore;
  pendingDevices: IPendingDeviceStore;
}

/** Build store implementations over an already-migrated {@link SqlDb}. */
export function buildStores(db: SqlDb): Omit<PersistenceStores, "db"> {
  return {
    identity: new IdentityRepo(db),
    sessions: new SessionRepo(db),
    home: new HomeRepo(db),
    scenes: new SceneRepo(db),
    grants: new GrantRepo(db),
    notifications: new NotificationRepo(db),
    drivers: new InstalledDriverRepo(db),
    automations: new AutomationRepo(db),
    security: new SecurityRepo(db),
    protocolBindings: new ProtocolBindingRepo(db),
    pushTokens: new PushTokenRepo(db),
    migrationPolicy: new MigrationPolicyRepo(db),
    config: new ConfigRepo(db),
    backups: new BackupRepo(db),
    pendingDevices: new PendingDeviceRepo(db),
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
