import type { BackendStateEvent } from "@supreme/integration-layer";
import { MockAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { IdentityService } from "@supreme/identity";
import { HomeService, seedDemoHome } from "@supreme/home";
import { SceneService } from "@supreme/scenes";
import { NotificationService } from "@supreme/notifications";
import {
  InMemoryGrantStore,
  PolicyEngine,
  buildGrant,
  type CreateGrantInput,
  type IGrantStore,
} from "@supreme/permissions";
import type { DeviceId, Grant, Notification, UserId } from "@supreme/domain-model";
import type { GatewayConfig } from "./config.js";

/**
 * Composition root for the hub's Supreme plane (§4, §13). Phase-1 runs the domain
 * services in-process behind their package boundaries; the hub Compose can later
 * split them into separate containers without changing callers. Stores default to
 * in-memory and are swapped for the Postgres-backed repositories (when a database
 * URL is configured) by the bootstrap layer.
 */
export type StateSubscriber = (event: BackendStateEvent) => void;
export type NotificationSubscriber = (n: Notification) => void;

export class AppContext {
  readonly identity: IdentityService;
  readonly policy = new PolicyEngine();
  readonly grants: IGrantStore = new InMemoryGrantStore();
  readonly sil: SupremeIntegrationLayer;
  readonly home: HomeService;
  readonly scenes: SceneService;
  readonly notifications: NotificationService;

  private readonly stateSubs = new Set<StateSubscriber>();
  private readonly notifySubs = new Set<NotificationSubscriber>();

  private constructor(readonly config: GatewayConfig) {
    this.identity = new IdentityService({ tokenSecret: config.tokenSecret });
    this.sil = buildSil(config);
    this.home = new HomeService(this.sil);
    this.scenes = new SceneService(this.sil);
    this.notifications = new NotificationService();

    // Fan SIL state events out to live WSS connections and update the device cache.
    this.sil.subscribe((event) => {
      void this.home.applyState(event.deviceId, event.state);
      for (const sub of this.stateSubs) sub(event);
    });
    // Bridge created notifications to WSS subscribers.
    this.notifications.onNotification((n) => {
      for (const sub of this.notifySubs) sub(n);
    });
  }

  static async create(config: GatewayConfig): Promise<AppContext> {
    const ctx = new AppContext(config);
    await ctx.sil.start();

    const { home } = await ctx.identity.commission({
      homeName: "Supreme Residence",
      email: "owner@supreme.local",
      password: "supreme-owner-demo-pass",
      displayName: "Home Owner",
    });
    await seedDemoHome(ctx.home, home);
    return ctx;
  }

  grantsFor(userId: UserId): Promise<Grant[]> {
    return this.grants.listForUser(userId);
  }
  async addGrant(input: CreateGrantInput): Promise<Grant> {
    const grant = buildGrant(input);
    await this.grants.add(grant);
    return grant;
  }

  onState(sub: StateSubscriber): () => void {
    this.stateSubs.add(sub);
    return () => this.stateSubs.delete(sub);
  }
  onNotification(sub: NotificationSubscriber): () => void {
    this.notifySubs.add(sub);
    return () => this.notifySubs.delete(sub);
  }

  roomOf(deviceId: DeviceId): Promise<string | null> {
    return this.home.roomOf(deviceId);
  }

  async shutdown(): Promise<void> {
    await this.sil.stop();
  }
}

function buildSil(config: GatewayConfig): SupremeIntegrationLayer {
  if (config.backend === "ha") {
    // The HaAdapter needs a concrete HA WebSocket transport injected at the hub
    // boot edge (infra/hub-compose), where the loopback HA URL + long-lived token
    // are available. See createHubContext in bootstrap.ts.
    throw new Error(
      "SUPREME_BACKEND=ha requires the HA transport injected via bootstrap.createHubContext; " +
        "use SUPREME_BACKEND=mock for the standalone slice",
    );
  }
  return new SupremeIntegrationLayer({ adapter: new MockAdapter() });
}
