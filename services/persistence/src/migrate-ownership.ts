import type { DeviceId } from "@supreme/domain-model";
import type { IDeviceProviderStore } from "@supreme/integration-layer";
import type { DeviceOwnershipRepo } from "./repositories/device-ownership-repo.js";

export interface OwnershipMigrationReport {
  migrated: { deviceId: DeviceId; provider: string }[];
  skippedAlreadyMigrated: DeviceId[];
  /** `kind === "unassigned"` (or an unrecognized kind) — no clear provider to
   * derive; never guessed, the device is left with no provider record (UNBOUND
   * once the runtime touches it, exactly like a never-commissioned device). */
  unresolvable: DeviceId[];
}

/**
 * One-time boot migration (ADR-0023 § Migration): `device_ownership` → `device_provider`.
 *
 *   kind="ha"     -> provider="homeassistant"
 *   kind="native" -> provider=<the bound driver's protocol>, i.e. `ownership.protocol`
 *   kind="unassigned" (or anything else) -> unresolvable, left alone, never guessed
 *
 * Every migrated device starts at lifecycle state UNBOUND — this migration only
 * records provenance (which provider a device used to be associated with); it does
 * NOT fabricate a bound/online state. The device becomes genuinely commandable again
 * only when something real binds it: `HomeService.rebindRegistry()` for Home
 * Assistant devices, or the existing native protocol-binding replay for native
 * devices — both already run on every boot, unchanged by this migration.
 *
 * Idempotent: a device already present in `device_provider` is skipped, so running
 * this on every boot (cheap — the ownership table only shrinks toward empty as
 * hubs upgrade) is safe. `device_ownership` itself is never written here — read-only
 * per ADR-0023 § Compatibility migrations may remain only for database upgrades.
 */
export async function migrateOwnershipToProvider(
  legacyOwnership: DeviceOwnershipRepo,
  providerStore: IDeviceProviderStore,
): Promise<OwnershipMigrationReport> {
  const report: OwnershipMigrationReport = { migrated: [], skippedAlreadyMigrated: [], unresolvable: [] };
  const [legacyRows, existing] = await Promise.all([legacyOwnership.list(), providerStore.list()]);
  const alreadyMigrated = new Set(existing.map((r) => r.deviceId));

  for (const row of legacyRows) {
    if (alreadyMigrated.has(row.deviceId)) {
      report.skippedAlreadyMigrated.push(row.deviceId);
      continue;
    }
    const provider = row.kind === "ha" ? "homeassistant" : row.kind === "native" && row.protocol ? row.protocol : null;
    if (!provider) {
      report.unresolvable.push(row.deviceId);
      continue;
    }
    await providerStore.put({ deviceId: row.deviceId, provider, state: "UNBOUND", updatedAt: new Date().toISOString() });
    report.migrated.push({ deviceId: row.deviceId, provider });
  }

  return report;
}
