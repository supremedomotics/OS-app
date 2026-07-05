/**
 * Native-migration policy (blueprint §7, §16 Phase 4) — the "strangler fig".
 *
 * The SIL routes each backend domain (e.g. "light", "climate", "cover") to either
 * the Home Assistant adapter or the Supreme-native engine. Domains default to HA;
 * an operator flips a domain to native behind this flag, validates, and HA is
 * retired for that domain — with ZERO change above the SIL. When every domain is
 * native, the HA adapter can be removed entirely.
 */
export type EngineKind = "ha" | "native";

/**
 * Persistence seam (§4) so a domain migrated to native STAYS native across a hub
 * restart — otherwise a reboot would silently route a migrated domain back to HA.
 */
export interface IMigrationPolicyStore {
  loadNativeDomains(): Promise<string[]>;
  setEngine(domain: string, engine: EngineKind): Promise<void>;
}

export class MigrationPolicy {
  /** domain → engine. Absent = default ("ha"). */
  private readonly engines = new Map<string, EngineKind>();
  private readonly store?: IMigrationPolicyStore;
  private lastWrite: Promise<void> = Promise.resolve();

  constructor(initialNativeDomains: string[] = [], store?: IMigrationPolicyStore) {
    for (const d of initialNativeDomains) this.engines.set(d, "native");
    this.store = store;
  }

  /** Restore persisted native domains on boot (no-op without a store). */
  async hydrate(): Promise<void> {
    if (!this.store) return;
    for (const domain of await this.store.loadNativeDomains()) this.engines.set(domain, "native");
  }

  /** Await the last persisted write (graceful shutdown / test determinism). */
  async flush(): Promise<void> {
    await this.lastWrite;
  }

  /** Note that a domain exists (so it appears in status even while on HA). */
  register(domain: string): void {
    if (!this.engines.has(domain)) this.engines.set(domain, "ha");
  }

  engineFor(domain: string): EngineKind {
    return this.engines.get(domain) ?? "ha";
  }

  isNative(domain: string): boolean {
    return this.engineFor(domain) === "native";
  }

  setEngine(domain: string, engine: EngineKind): void {
    this.engines.set(domain, engine);
    if (this.store) this.lastWrite = this.store.setEngine(domain, engine).catch(() => {});
  }

  /** Current routing for all known domains. */
  status(): { domain: string; engine: EngineKind }[] {
    return [...this.engines.entries()]
      .map(([domain, engine]) => ({ domain, engine }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
  }

  /** True once every known domain is routed to native (HA can be retired). */
  fullyMigrated(): boolean {
    const all = [...this.engines.values()];
    return all.length > 0 && all.every((e) => e === "native");
  }
}
