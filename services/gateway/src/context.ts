import type { BackendStateEvent } from "@supreme/integration-layer";
import { MockAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { IdentityService, type IIdentityStore, type ISessionStore } from "@supreme/identity";
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
import {
  AutomationEngine,
  AutomationService,
  type AutomationExecutors,
  type IAutomationStore,
} from "@supreme/automations";
import { AnalyticsService } from "@supreme/analytics";
import { AuditService } from "@supreme/audit";
import { AssistantService } from "@supreme/ai";
import { SecurityService } from "@supreme/security";
import type { GatewayConfig } from "./config.js";
import { InstallerServices } from "./installer-context.js";

/** Injected dependencies — the SIL and the persisted stores. Anything omitted
 * falls back to the in-memory default (used by dev and tests). */
export interface AppDeps {
  sil?: SupremeIntegrationLayer;
  identityStore?: IIdentityStore;
  sessionStore?: ISessionStore;
  homeStore?: IHomeStore;
  sceneStore?: ISceneStore;
  grantStore?: IGrantStore;
  notificationStore?: INotificationStore;
  driverStore?: IInstalledDriverStore;
  automationStore?: IAutomationStore;
  /** The underlying SQL database (when persistence is enabled) — for backup/restore, analytics, audit. */
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
  /** Intelligence & scale (§16): automations, energy analytics, audit, AI assistant. */
  automations!: AutomationService;
  analytics: AnalyticsService | null = null;
  audit: AuditService | null = null;
  readonly ai: AssistantService;
  readonly security: SecurityService;
  homeId!: HomeId;

  private ready = false;
  private readonly deps: AppDeps;
  private readonly stateSubs = new Set<StateSubscriber>();
  private readonly notifySubs = new Set<NotificationSubscriber>();

  private constructor(readonly config: GatewayConfig, deps: AppDeps = {}) {
    this.deps = deps;
    this.identity = new IdentityService({
      tokenSecret: config.tokenSecret,
      store: deps.identityStore,
      sessionStore: deps.sessionStore,
    });
    this.sil = deps.sil ?? buildSil(config);
    this.home = new HomeService(this.sil, deps.homeStore);
    this.scenes = new SceneService(this.sil, deps.sceneStore);
    this.notifications = new NotificationService(deps.notificationStore);
    this.grants = deps.grantStore ?? new InMemoryGrantStore();
    this.ai = new AssistantService({ modelUrl: config.aiUrl || undefined });
    this.security = new SecurityService({
      onChange: (state, actor) => {
        void this.audit?.record({
          homeId: this.homeId,
          actorUserId: actor,
          action: state.triggered ? "security.triggered" : `security.${state.mode}`,
          resourceType: "home",
          resourceId: this.homeId,
        });
        if (state.triggered) {
          void this.notifications.create({
            homeId: this.homeId,
            userId: null,
            level: "critical",
            title: "Security alarm",
            body: "A sensor was triggered while the system was armed.",
          });
        }
      },
    });

    // Fan SIL state events out to live WSS connections, the device cache, the
    // automation engine, and the analytics time-series.
    this.sil.subscribe((event) => {
      void this.onBackendState(event);
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

    ctx.homeId = home.id as HomeId;

    // Intelligence services. The automation engine's side effects flow through the
    // SIL, scenes, and notifications; analytics + audit require a database.
    const executors: AutomationExecutors = {
      command: (deviceId, command) => ctx.sil.command(deviceId, command),
      activateScene: async (sceneId) => {
        await ctx.scenes.activate(sceneId);
      },
      notify: async (input) => {
        await ctx.notifications.create({
          homeId: ctx.homeId,
          userId: input.userId,
          level: input.level,
          title: input.title,
          body: input.body,
        });
      },
      getState: (deviceId, capability) => ctx.sil.getState(deviceId, capability),
    };
    const engine = new AutomationEngine({
      executors,
      onRun: (id, ok) => {
        void ctx.audit?.record({
          homeId: ctx.homeId,
          action: ok ? "automation.run" : "automation.error",
          resourceType: "automation",
          resourceId: id,
        });
      },
    });
    ctx.automations = new AutomationService(engine, deps.automationStore);
    await ctx.automations.start();

    if (deps.db) {
      ctx.analytics = new AnalyticsService(deps.db);
      ctx.audit = new AuditService(deps.db);
    }

    ctx.ready = true;
    return ctx;
  }

  /** Handle a normalized backend state delta: cache, fan-out, automations, analytics. */
  private async onBackendState(event: BackendStateEvent): Promise<void> {
    await this.home.applyState(event.deviceId, event.state);
    for (const sub of this.stateSubs) sub(event);
    if (!this.ready) return;
    await this.automations.onDeviceState({
      deviceId: event.deviceId,
      capability: event.capability,
      state: event.state,
    });
    if (this.analytics) {
      const roomId = (await this.home.roomOf(event.deviceId)) as never;
      await this.analytics.ingestState(
        { homeId: this.homeId, deviceId: event.deviceId, roomId },
        event.state,
      );
    }
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
