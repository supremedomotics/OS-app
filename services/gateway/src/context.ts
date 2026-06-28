import type { BackendStateEvent } from "@supreme/integration-layer";
import { MockAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { IdentityService, type IIdentityStore, type ISessionStore } from "@supreme/identity";
import { SupremeError, type LoginResponse } from "@supreme/contracts";
import { HomeService, seedDemoHome, type IHomeStore } from "@supreme/home";
import { SceneService, type ISceneStore } from "@supreme/scenes";
import {
  NotificationService,
  PushService,
  RelayPushProvider,
  InMemoryPushTokenStore,
  type INotificationStore,
  type IPushProvider,
  type IPushTokenStore,
} from "@supreme/notifications";
import {
  InMemoryGrantStore,
  PolicyEngine,
  buildGrant,
  type CreateGrantInput,
  type IGrantStore,
} from "@supreme/permissions";
import type { DeviceId, Grant, Home, HomeId, Notification, UserId } from "@supreme/domain-model";
import type { IInstalledDriverStore } from "@supreme/drivers";
import type { IProtocolScanner } from "@supreme/commissioning";
import type { SqlDb } from "@supreme/persistence";
import {
  InMemoryPresenceStore,
  InProcessEventBus,
  subjects,
  type IEventBus,
  type IPresenceStore,
} from "@supreme/messaging";
import type { IProtocolBindingStore } from "@supreme/integration-layer";
import {
  AutomationEngine,
  AutomationService,
  type AutomationExecutors,
  type IAutomationStore,
} from "@supreme/automations";
import { AnalyticsService } from "@supreme/analytics";
import { AuditService } from "@supreme/audit";
import { AssistantService } from "@supreme/ai";
import { SecurityService, type ISecurityStore } from "@supreme/security";
import { StreamGateway, NullStreamGateway, type ICameraStreamGateway } from "@supreme/cameras";
import { CameraService } from "./camera-service.js";
import type { GatewayConfig } from "./config.js";
import { InstallerServices } from "./installer-context.js";
import type { MatterFabricManager, MatterProtocolDriver } from "@supreme/protocols";
import type { VoiceStatePublisher } from "./voice-publisher.js";

/** The hub's optional Matter controller handle, present only when Matter is enabled AND its
 * controller subsystem is available. Lets the Matter routes pair devices by setup code and report
 * status without reaching into the SIL's driver internals. */
export interface MatterHandle {
  driver: MatterProtocolDriver;
  fabric: MatterFabricManager | null;
}

/** Injected dependencies — the SIL and the persisted stores. Anything omitted
 * falls back to the in-memory default (used by dev and tests). */
export interface AppDeps {
  sil?: SupremeIntegrationLayer;
  /** Matter controller handle (set by bootstrap when Matter is enabled). */
  matter?: MatterHandle;
  /** Publisher for proactive voice state reporting (set by bootstrap when the Voice cloud is wired). */
  voicePublisher?: VoiceStatePublisher;
  /** Cross-process event bus (NATS in prod); defaults to in-process. */
  bus?: IEventBus;
  /** Shared presence store (Redis in prod); defaults to in-process. */
  presence?: IPresenceStore;
  identityStore?: IIdentityStore;
  sessionStore?: ISessionStore;
  homeStore?: IHomeStore;
  sceneStore?: ISceneStore;
  grantStore?: IGrantStore;
  notificationStore?: INotificationStore;
  driverStore?: IInstalledDriverStore;
  automationStore?: IAutomationStore;
  securityStore?: ISecurityStore;
  protocolBindingStore?: IProtocolBindingStore;
  pushTokenStore?: IPushTokenStore;
  /** Override push providers (tests); otherwise selected from config. */
  pushProviders?: IPushProvider[];
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
  /** Push delivery (§13): forwards notifications to registered device tokens. */
  readonly push: PushService;
  /** Registered device push tokens (persisted when a DB is configured). */
  readonly pushTokens: IPushTokenStore;
  /** Installer/admin surfaces (drivers, commissioning, diagnostics, backup, licensing). */
  installer!: InstallerServices;
  /** Intelligence & scale (§16): automations, energy analytics, audit, AI assistant. */
  automations!: AutomationService;
  analytics: AnalyticsService | null = null;
  audit: AuditService | null = null;
  readonly ai: AssistantService;
  readonly security: SecurityService;
  /** Camera registry + RTSP→HLS/WebRTC stream resolution (§11.1). */
  cameras!: CameraService;
  /** The underlying SQL database when persistence is enabled; null = in-memory. Used by the readiness probe. */
  readonly db: SqlDb | null;
  /** Cross-process event bus: device state + notifications fan out over this (§5). */
  readonly bus: IEventBus;
  /** Shared presence store: who is connected right now (§5). */
  readonly presence: IPresenceStore;
  /** Matter controller handle when Matter is enabled + its controller is running; null otherwise. */
  readonly matter: MatterHandle | null;
  /** Proactive voice state publisher when the Voice cloud is wired; null otherwise. */
  readonly voicePublisher: VoiceStatePublisher | null;
  homeId!: HomeId;
  /** True on production first boot until the Setup Wizard creates the administrator.
   * While true, only /healthz and /v1/setup are functional (no demo home is seeded). */
  setupRequired = false;

  private ready = false;
  private readonly deps: AppDeps;
  private readonly stateSubs = new Set<StateSubscriber>();
  private readonly notifySubs = new Set<NotificationSubscriber>();
  /** Last value seen per event-sensor (deviceId:measure) for rising-edge detection. */
  private readonly lastEventValue = new Map<string, number>();

  private constructor(readonly config: GatewayConfig, deps: AppDeps = {}) {
    this.deps = deps;
    this.db = deps.db ?? null;
    this.bus = deps.bus ?? new InProcessEventBus();
    this.presence = deps.presence ?? new InMemoryPresenceStore();
    this.matter = deps.matter ?? null;
    this.voicePublisher = deps.voicePublisher ?? null;
    this.identity = new IdentityService({
      tokenSecret: config.tokenSecret,
      store: deps.identityStore,
      sessionStore: deps.sessionStore,
    });
    this.sil = deps.sil ?? buildSil(config);
    this.home = new HomeService(this.sil, deps.homeStore);
    this.scenes = new SceneService(this.sil, deps.sceneStore);
    this.notifications = new NotificationService(deps.notificationStore);
    // Push delivery (§13): cloud relay when configured, otherwise WSS-only (no provider).
    this.pushTokens = deps.pushTokenStore ?? new InMemoryPushTokenStore();
    const pushProviders: IPushProvider[] =
      deps.pushProviders ??
      (config.pushRelayUrl
        ? [new RelayPushProvider({ url: config.pushRelayUrl, authToken: config.pushRelayToken || undefined })]
        : []);
    this.push = new PushService(this.pushTokens, pushProviders);
    this.grants = deps.grantStore ?? new InMemoryGrantStore();
    this.ai = new AssistantService({ modelUrl: config.aiUrl || undefined });
    this.security = new SecurityService({
      store: deps.securityStore,
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
    // Bridge created notifications onto the event bus (cross-process WSS fan-out) and,
    // additionally, to push for backgrounded/offline devices (no-op without a provider).
    this.notifications.onNotification((n) => {
      void this.bus.publish(subjects.notification(this.homeId), n);
      void this.push.deliver(n);
    });
  }

  /**
   * Drive the local WSS fan-out from the event bus rather than from direct in-process
   * calls. With the in-process bus this is observably identical to before; with NATS,
   * a state delta produced by the SIL-owning process reaches WSS clients on EVERY
   * gateway process. Wildcard subjects avoid needing the home id at subscribe time.
   */
  private async subscribeBus(): Promise<void> {
    await this.bus.subscribe<BackendStateEvent>("supreme.home.*.device.state", (event) => {
      for (const sub of this.stateSubs) sub(event);
    });
    await this.bus.subscribe<Notification>("supreme.home.*.notification", (n) => {
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
    await ctx.subscribeBus();
    await ctx.sil.start();

    let home = await ctx.home.getHome();
    if (!home && config.setupWizard) {
      // Production first boot: NO demo owner is created. The hub serves only /healthz and
      // /v1/setup until the Supreme Setup Wizard creates the administrator. Home Assistant
      // is still provisioned/connected (above) — only the Supreme admin is pending.
      ctx.setupRequired = true;
      return ctx;
    }
    if (home) {
      await ctx.home.rebindRegistry();
    } else {
      // Dev/test default: auto-commission a demo owner + seed a demo home.
      const commissioned = await ctx.identity.commission({
        homeName: "Supreme Residence",
        email: "owner@supreme.local",
        password: "supreme-owner-demo-pass",
        displayName: "Home Owner",
      });
      home = commissioned.home;
      await seedDemoHome(ctx.home, home);
    }
    await ctx.initWithHome(home);
    return ctx;
  }

  /**
   * Initialize everything that requires a commissioned home — installer surfaces, camera
   * streaming, the security panel, automations, analytics/audit. Shared by normal boot
   * and by the Setup Wizard ({@link completeSetup}) so the post-home wiring lives once.
   */
  private async initWithHome(home: Home): Promise<void> {
    const { config, deps } = this;
    this.installer = new InstallerServices({
      config,
      sil: this.sil,
      home: this.home,
      scenes: this.scenes,
      identity: this.identity,
      homeId: home.id as HomeId,
      driverStore: deps.driverStore,
      db: deps.db,
      scanners: deps.scanners,
      protocolBindingStore: deps.protocolBindingStore,
    });
    await this.installer.init();

    this.homeId = home.id as HomeId;

    const streamGateway: ICameraStreamGateway = config.streamBaseUrl
      ? new StreamGateway({
          engine: config.streamEngine === "mediamtx" ? "mediamtx" : "go2rtc",
          baseUrl: config.streamBaseUrl,
          apiUrl: config.streamApiUrl || undefined,
        })
      : new NullStreamGateway();
    this.cameras = new CameraService(this.home, streamGateway, this.homeId);

    await this.security.hydrate(this.homeId);

    const executors: AutomationExecutors = {
      command: (deviceId, command) => this.sil.command(deviceId, command),
      activateScene: async (sceneId) => {
        await this.scenes.activate(sceneId);
      },
      notify: async (input) => {
        await this.notifications.create({
          homeId: this.homeId,
          userId: input.userId,
          level: input.level,
          title: input.title,
          body: input.body,
        });
      },
      getState: (deviceId, capability) => this.sil.getState(deviceId, capability),
    };
    const engine = new AutomationEngine({
      executors,
      onRun: (id, ok) => {
        void this.audit?.record({
          homeId: this.homeId,
          action: ok ? "automation.run" : "automation.error",
          resourceType: "automation",
          resourceId: id,
        });
      },
    });
    this.automations = new AutomationService(engine, deps.automationStore);
    await this.automations.start();

    if (deps.db) {
      this.analytics = new AnalyticsService(deps.db);
      this.audit = new AuditService(deps.db);
    }

    this.ready = true;
  }

  /**
   * Complete the Setup Wizard: create the Supreme OS administrator (and the home) from
   * the installer's input, finish initialization, and return an authenticated session so
   * the wizard lands logged in. Supreme-only — no Home Assistant user is ever created.
   */
  async completeSetup(input: {
    username: string;
    password: string;
    displayName?: string;
    systemName: string;
    location?: string | null;
    timeZone?: string | null;
  }): Promise<{ login: LoginResponse; loginEmail: string }> {
    if (!this.setupRequired) {
      throw new SupremeError("conflict", "Supreme OS is already set up");
    }
    // Accept a username or an email; store an email-shaped identifier for login.
    const loginEmail = input.username.includes("@")
      ? input.username
      : `${input.username}@supreme.local`;
    const { home } = await this.identity.commission({
      homeName: input.systemName || "Supreme Residence",
      email: loginEmail,
      password: input.password,
      displayName: input.displayName?.trim() || input.username,
    });
    await this.initWithHome(home);
    this.setupRequired = false;
    const login = await this.identity.login(loginEmail, input.password);
    return { login, loginEmail };
  }

  /** Handle a normalized backend state delta: cache, fan-out, automations, analytics. */
  private async onBackendState(event: BackendStateEvent): Promise<void> {
    await this.home.applyState(event.deviceId, event.state);
    // Publish to the bus; the bus subscription (subscribeBus) drives WSS fan-out —
    // in-process today, cross-process under NATS.
    await this.bus.publish(subjects.deviceState(this.homeId), event);
    if (!this.ready) return;
    // Proactive voice reporting: tell the cloud (debounced) so Alexa/Google stay in sync (ADR 0010).
    this.voicePublisher?.publish(event);
    await this.maybeNotifyEvent(event);
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

  /**
   * Turn fundamental "event" sensors into notifications on their rising edge (§13).
   * A SIP door station emits a `ring` sensor; leak/smoke detectors emit theirs. These
   * fire a broadcast notification — which fans out over WSS and (when enabled) push —
   * without the homeowner having to author an automation. Edge-triggered so a sensor
   * that holds its value doesn't spam.
   */
  private async maybeNotifyEvent(event: BackendStateEvent): Promise<void> {
    if (event.state.kind !== "sensor") return;
    const spec = EVENT_NOTIFICATIONS[event.state.measure];
    if (!spec) return;
    const key = `${event.deviceId}:${event.state.measure}`;
    const prev = this.lastEventValue.get(key) ?? 0;
    this.lastEventValue.set(key, event.state.value);
    if (!(event.state.value > 0 && prev <= 0)) return; // rising edge only
    const device = await this.home.getDevice(event.deviceId);
    await this.notifications.create({
      homeId: this.homeId,
      userId: null,
      level: spec.level,
      title: device?.name ?? spec.title,
      body: spec.body,
      context: { deviceId: event.deviceId, event: event.state.measure },
    });
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
    this.voicePublisher?.stop();
    await this.security.flush();
    await this.sil.stop();
    await this.bus.close();
    await this.presence.close();
  }
}

/** Event-sensor measures that auto-raise a notification on their rising edge (§13). */
const EVENT_NOTIFICATIONS: Record<
  string,
  { level: Notification["level"]; title: string; body: string }
> = {
  ring: { level: "warning", title: "Door station", body: "Someone is at the door" },
  leak: { level: "critical", title: "Leak detector", body: "Water leak detected" },
  smoke: { level: "critical", title: "Smoke detector", body: "Smoke detected" },
};

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
