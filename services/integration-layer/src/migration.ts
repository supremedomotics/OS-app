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

export class MigrationPolicy {
  /** domain → engine. Absent = default ("ha"). */
  private readonly engines = new Map<string, EngineKind>();

  constructor(initialNativeDomains: string[] = []) {
    for (const d of initialNativeDomains) this.engines.set(d, "native");
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
