import { MATTER_DEVICE_TYPES, type MatterDeviceTypeDefinition } from "./matter-device-types.js";

/**
 * Canonical, authoritative lookup over {@link MATTER_DEVICE_TYPES} (§ Matter Bridge Phase 1
 * foundation). Every consumer — the resolver below, `real-server.ts`'s endpoint construction,
 * the endpoint registry's migration path, a future diagnostics surface — goes through this
 * registry rather than importing the raw array and re-deriving a `byId` lookup of its own.
 */
export class MatterDeviceTypeRegistry {
  private readonly byIdMap = new Map<number, MatterDeviceTypeDefinition>();

  constructor(definitions: MatterDeviceTypeDefinition[] = MATTER_DEVICE_TYPES) {
    for (const d of definitions) this.byIdMap.set(d.id, d);
  }

  byId(id: number): MatterDeviceTypeDefinition | null {
    return this.byIdMap.get(id) ?? null;
  }

  all(): MatterDeviceTypeDefinition[] {
    return [...this.byIdMap.values()];
  }
}

/** The one registry instance every bridge-side consumer shares — device types are a fixed,
 * spec-derived table, not per-instance state (§ singleton justified: this mirrors how
 * `MatterClusterId` is a shared constant, not something any caller constructs). */
export const matterDeviceTypeRegistry = new MatterDeviceTypeRegistry();
