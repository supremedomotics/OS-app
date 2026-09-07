/**
 * Native-engine domain registry (blueprint §7, §16 Phase 4).
 *
 * Historical note: this tracked per-domain migration off Home Assistant onto the
 * Supreme-native engine. HA has been fully removed from the runtime — "native" is
 * now the only engine — so this is retained purely as a domain-status registry for
 * the `/v1/migration` installer reporting surface, not an active routing decision.
 */
export type EngineKind = "native";

/**
 * Persistence seam (§4) so a domain's registered status survives a hub restart.
 */
export interface IMigrationPolicyStore {
  loadNativeDomains(): Promise<string[]>;
  setEngine(domain: string, engine: EngineKind): Promise<void>;
}

export class MigrationPolicy {
  /** domain → engine. Absent = default ("native"). */
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

  /** Note that a domain exists (so it appears in status). */
  register(domain: string): void {
    if (!this.engines.has(domain)) this.engines.set(domain, "native");
  }

  engineFor(domain: string): EngineKind {
    return this.engines.get(domain) ?? "native";
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

  /** True once every known domain has a status entry (always true post-registration). */
  fullyMigrated(): boolean {
    const all = [...this.engines.values()];
    return all.length > 0 && all.every((e) => e === "native");
  }
}
