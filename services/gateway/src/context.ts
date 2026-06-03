import type { BackendStateEvent } from "@supreme/integration-layer";
import { MockAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { IdentityService } from "@supreme/identity";
import { PolicyEngine } from "@supreme/permissions";
import type { DeviceId, Grant, UserId } from "@supreme/domain-model";
import type { GatewayConfig } from "./config.js";
import { HomeState, seedDemoHome } from "./home-state.js";

/**
 * Composition root for the hub's Supreme plane. For Phase 0 the gateway runs the
 * domain services in-process behind their package boundaries; the hub Compose can
 * later split them into separate containers without changing callers (§4, §13).
 */
export type StateSubscriber = (event: BackendStateEvent) => void;

export class AppContext {
  readonly identity: IdentityService;
  readonly policy = new PolicyEngine();
  readonly sil: SupremeIntegrationLayer;
  readonly home: HomeState;

  /** ABAC grants per user (in-memory for Phase 0). */
  private readonly grants = new Map<UserId, Grant[]>();
  private readonly subscribers = new Set<StateSubscriber>();

  private constructor(readonly config: GatewayConfig) {
    this.identity = new IdentityService({ tokenSecret: config.tokenSecret });
    this.sil = buildSil(config);
    this.home = new HomeState(this.sil);

    // Fan SIL state events out to all live WSS connections and update the cache.
    this.sil.subscribe((event) => {
      this.home.applyState(event.deviceId, event.state);
      for (const sub of this.subscribers) sub(event);
    });
  }

  static async create(config: GatewayConfig): Promise<AppContext> {
    const ctx = new AppContext(config);
    await ctx.sil.start();

    // Commission a demo home + master so the slice is immediately controllable.
    const { home } = await ctx.identity.commission({
      homeName: "Supreme Residence",
      email: "owner@supreme.local",
      password: "supreme-owner-demo-pass",
      displayName: "Home Owner",
    });
    seedDemoHome(ctx.home, home);
    return ctx;
  }

  grantsFor(userId: UserId): Grant[] {
    return this.grants.get(userId) ?? [];
  }
  addGrant(grant: Grant): void {
    const list = this.grants.get(grant.userId) ?? [];
    list.push(grant);
    this.grants.set(grant.userId, list);
  }

  onState(sub: StateSubscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** Resolve the room a device lives in (for permission-scoped fan-out). */
  roomOf(deviceId: DeviceId): string | null {
    return this.home.getDevice(deviceId)?.roomId ?? null;
  }

  async shutdown(): Promise<void> {
    await this.sil.stop();
  }
}

function buildSil(config: GatewayConfig): SupremeIntegrationLayer {
  if (config.backend === "ha") {
    // The HaAdapter needs a concrete HA WebSocket transport, which is injected at
    // the hub boot edge (infra/hub-compose) where the loopback HA URL + long-lived
    // token are available. The Phase-0 vertical slice runs the mock backend.
    throw new Error(
      "SUPREME_BACKEND=ha requires the HA transport injected at the hub boot edge; " +
        "use SUPREME_BACKEND=mock for the standalone Phase-0 slice",
    );
  }
  return new SupremeIntegrationLayer({ adapter: new MockAdapter() });
}
