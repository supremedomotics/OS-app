import { z } from "zod";

/**
 * Phase-4 contracts (§16): native migration controls. The visible API never
 * changes as domains move from HA to the Supreme-native engine — these endpoints
 * only drive the migration itself (installer/admin surface).
 */
export const EngineKind = z.enum(["ha", "native"]);
export type EngineKind = z.infer<typeof EngineKind>;

export const MigrationStatus = z.object({
  /** Whether per-domain migration is available (a routing backend is in use). */
  enabled: z.boolean(),
  domains: z.array(z.object({ domain: z.string(), engine: EngineKind })),
  /** True once every known domain runs natively (HA can be retired). */
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
