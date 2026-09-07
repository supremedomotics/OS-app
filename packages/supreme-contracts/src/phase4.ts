import { z } from "zod";

/**
 * Phase-4 contracts (§16): native-engine domain status. SupremeOS has no external
 * home-automation backend — "native" is the only engine — so these endpoints are
 * retained purely as an installer/admin domain-status reporting surface.
 */
export const EngineKind = z.enum(["native"]);
export type EngineKind = z.infer<typeof EngineKind>;

export const MigrationStatus = z.object({
  /** Whether per-domain status reporting is available (a routing backend is in use). */
  enabled: z.boolean(),
  domains: z.array(z.object({ domain: z.string(), engine: EngineKind })),
  /** True once every known domain has a status entry. */
  fullyMigrated: z.boolean(),
});
export type MigrationStatus = z.infer<typeof MigrationStatus>;

export const MigrateDomainRequest = z.object({ engine: EngineKind });
export type MigrateDomainRequest = z.infer<typeof MigrateDomainRequest>;

export const MigrateDomainResponse = z.object({
  domain: z.string(),
  engine: EngineKind,
  /** Number of device/capability pairs moved onto the native engine. */
  moved: z.number().int().nonnegative(),
});
export type MigrateDomainResponse = z.infer<typeof MigrateDomainResponse>;
