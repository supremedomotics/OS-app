import type { IKnxProvider, KnxTask, KnxTaskKind, ProviderDiagnostics } from "./provider.js";

/**
 * Internal Task Router (§ Internal Task Router, § Fundamental Design Principle).
 *
 * KNX Ultimate and KNX IoT are not competing drivers — they are specialized internal
 * providers that cooperate. The router's only job is picking the ONE correct provider
 * for a given task type, by an explicit routing table — never a fallback chain, never
 * "try provider A, if that fails try B". A task type with no registered provider is a
 * configuration error and throws immediately rather than silently no-op'ing.
 *
 * Today only `bus.*`/`dpt.*`/`security.*`/`transport.*` tasks are routed anywhere
 * (to {@link "./knx-ultimate-provider.js" KnxUltimateProvider}, the only provider that
 * exists) — the `discovery.*` task kinds are wired into the routing table so a future
 * KNX IoT provider slots in with a one-line registration, but have no provider
 * registered yet in this codebase (see the architecture document's Migration
 * Strategy: no KNX IoT dependency exists here today).
 */
export class KnxTaskRouter {
  private readonly routes = new Map<KnxTaskKind, IKnxProvider>();

  /** Register the provider responsible for a task kind. Re-registering the same kind
   * replaces the previous provider (used when a provider is swapped, never to add a
   * second candidate for the same kind — routing is 1:1, by design). */
  register(kind: KnxTaskKind, provider: IKnxProvider): void {
    this.routes.set(kind, provider);
  }

  providerFor(kind: KnxTaskKind): IKnxProvider {
    const provider = this.routes.get(kind);
    if (!provider) throw new Error(`knx task router: no provider registered for "${kind}"`);
    return provider;
  }

  async execute(task: KnxTask): Promise<unknown> {
    return this.providerFor(task.kind).execute(task);
  }

  /** Every distinct provider currently registered for at least one task kind —
   * diagnostics/health iterate this, never a hardcoded provider list. */
  registeredProviders(): IKnxProvider[] {
    return [...new Set(this.routes.values())];
  }

  /** Aggregate diagnostics across every registered provider (§ Diagnostics: "Provider
   * Health" and "Packet Statistics" are explicitly BOTH-providers fields). */
  diagnostics(): ProviderDiagnostics[] {
    return this.registeredProviders().map((p) => p.diagnostics());
  }
}
