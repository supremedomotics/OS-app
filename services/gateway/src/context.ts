import type { BackendStateEvent } from "@supreme/integration-layer";
import { MockAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { IdentityService, type IIdentityStore } from "@supreme/identity";
import { HomeService, seedDemoHome, type IHomeStore } from "@supreme/home";
import { SceneService, type ISceneStore } from "@supreme/scenes";
import { NotificationService, type INotificationStore } from "@supreme/notifications";
import {
  InMemoryGrantStore,
  PolicyEngine,
  buildGrant,
  type CreateGrantInput,
  type IGrantStore,
} from "@supreme/permissions";
import type { DeviceId, Grant, HomeId, Notification, UserId } from "@supreme/domain-model";
import type { IInstalledDriverStore } from "@supreme/drivers";
import type { IProtocolScanner } from "@supreme/commissioning";
import type { SqlDb } from "@supreme/persistence";
import type { GatewayConfig } from "./config.js";
import { InstallerServices } from "./installer-context.js";

/** Injected dependencies — the SIL and the persisted stores. Anything omitted
 * falls back to the in-memory default (used by dev and tests). */
export interface AppDeps {
  sil?: SupremeIntegrationLayer;
  identityStore?: IIdentityStore;
  homeStore?: IHomeStore;
  sceneStore?: ISceneStore;
  grantStore?: IGrantStore;
  notificationStore?: INotificationStore;
  driverStore?: IInstalledDriverStore;
  /** The underlying SQL database (when persistence is enabled) — for backup/restore. */
  db?: SqlDb;
  /** Protocol scanners for commissioning (KNX/DALI/Modbus tooling). */
  scanners?: IProtocolScanner[];
}

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
  readonly grants: IGrantStore;
  readonly sil: SupremeIntegrationLayer;
  readonly home: HomeService;
  readonly scenes: SceneService;
  readonly notifications: NotificationService;
  /** Installer/admin surfaces (drivers, commissioning, diagnostics, backup, licensing). */
  installer!: InstallerServices;

  private readonly deps: AppDeps;
  private readonly stateSubs = new Set<StateSubscriber>();
  private readonly notifySubs = new Set<NotificationSubscriber>();

  private constructor(readonly config: GatewayConfig, deps: AppDeps = {}) {
    this.deps = deps;
    this.identity = new IdentityService({
      tokenSecret: config.tokenSecret,
      store: deps.identityStore,
    });
    this.sil = deps.sil ?? buildSil(config);
    this.home = new HomeService(this.sil, deps.homeStore);
    this.scenes = new SceneService(this.sil, deps.sceneStore);
    this.notifications = new NotificationService(deps.notificationStore);
    this.grants = deps.grantStore ?? new InMemoryGrantStore();

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

  /**
   * Build and start the context. A pre-built SIL and/or persisted stores may be
   * injected (see {@link createHubContext}); otherwise the mock backend and
   * in-memory stores are used.
   *
   * First boot commissions a demo home + Master User and seeds demo devices. On a
   * persisted hub, subsequent boots find the existing home and instead rebind the
   * stored devices' capabilities into the SIL registry — no re-commission.
   */
  static async create(config: GatewayConfig, deps: AppDeps = {}): Promise<AppContext> {
    const ctx = new AppContext(config, deps);
    await ctx.sil.start();

    let home = await ctx.home.getHome();
    if (home) {
      await ctx.home.rebindRegistry();
    } else {
      const commissioned = await ctx.identity.commission({
        homeName: "Supreme Residence",
        email: "owner@supreme.local",
        password: "supreme-owner-demo-pass",
        displayName: "Home Owner",
      });
      home = commissioned.home;
      await seedDemoHome(ctx.home, home);
    }

    // The installer services need the commissioned home id and the persisted stores.
    ctx.installer = new InstallerServices({
      config,
      sil: ctx.sil,
      home: ctx.home,
      scenes: ctx.scenes,
      identity: ctx.identity,
      homeId: home.id as HomeId,
      driverStore: deps.driverStore,
      db: deps.db,
      scanners: deps.scanners,
    });
    await ctx.installer.init();
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
