import type { BackendStateEvent } from "@supreme/integration-layer";
import { MockAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { IdentityService, type IIdentityStore, type ISessionStore, type IApiTokenStore, type IWebAuthnStore } from "@supreme/identity";
import { SupremeError, type LoginResponse } from "@supreme/contracts";
import { HomeService, InMemoryConfigStore, seedDemoHome, type IConfigStore, type IHomeStore } from "@supreme/home";
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
import { newId } from "@supreme/domain-model";
import type { IInstalledDriverStore, DriverSecretCrypto } from "@supreme/drivers";
import type { IProtocolScanner } from "@supreme/commissioning";
import type { SqlDb } from "@supreme/persistence";
import {
  InMemoryPresenceStore,
  InProcessEventBus,
  subjects,
  type IEventBus,
  type IPresenceStore,
} from "@supreme/messaging";
import type { IProtocolBindingStore, IDeviceProviderStore, INativeProtocolDriver } from "@supreme/integration-layer";
import type { IBackupStore, IPendingDeviceStore } from "@supreme/persistence";
import {
  AutomationEngine,
  AutomationService,
  type AutomationExecutors,
  type IAutomationStore,
} from "@supreme/automations";
import {
  InMemoryKeypadSubscriptionStore,
  KeypadMappingEngine,
  KeypadMappingService,
  SubscriptionManager,
  UniversalFeedbackEngine,
  UniversalInputEngine,
  type IKeypadMappingStore,
  type IKeypadSubscriptionStore,
} from "@supreme/keypad-framework";
import {
  CapabilityIndex,
  IntentEngine,
  IntentRegistry,
  registerBuiltinIntents,
  type IntentEngineExecutors,
} from "@supreme/intent-engine";
import { AnalyticsService } from "@supreme/analytics";
import { AuditService } from "@supreme/audit";
import { AssistantService } from "@supreme/ai";
import { SecurityService, type ISecurityStore } from "@supreme/security";
import { StreamGateway, NullStreamGateway, type ICameraStreamGateway } from "@supreme/cameras";
import { CameraService } from "./camera-service.js";
import type { GatewayConfig } from "./config.js";
import { InstallerServices, type KnxDiscoveryDriverFactory } from "./installer-context.js";
import type { MatterFabricManager, MatterProtocolDriver } from "@supreme/protocols";
import type { VoiceStatePublisher } from "./voice-publisher.js";
import { HapBridge, type HapCommand, type HapTransport } from "@supreme/homekit";
import type { CapabilityCommand } from "@supreme/domain-model";
import { OccupancyRunner } from "./occupancy-runner.js";
import { SceneScheduler } from "./scene-scheduler.js";
import { ClimateProgramRunner } from "./climate-runner.js";
import { ClimateScheduler } from "./climate-scheduler.js";
import { AlertRuleRunner, type AlertRule } from "./alert-runner.js";
import { LoadShiftRunner } from "./load-shift-runner.js";
import { VentilationRunner, type VentilationConfig } from "./ventilation-runner.js";
import { ConsumptionEstimator } from "./consumption-estimator.js";
import { BudgetMonitor, type EnergyBudget } from "./budget-monitor.js";
import { SieRunner } from "./sie-runner.js";
import type { AutoPilotSettings, DeviceIntel, SuggestionState, Zone } from "@supreme/intelligence";
import { IntelligenceRepo } from "@supreme/persistence";
import type { ClimateProgram, ClimateScheduleEvent } from "@supreme/automations";
import type { Tariff, RateFetcher } from "@supreme/analytics";
import type { SceneSchedule } from "@supreme/scenes";
import type { SceneId } from "@supreme/domain-model";

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
  /** HomeKit HAP transport (hap-nodejs-backed). Present → the local HomeKit bridge is enabled. */
  homekitTransport?: HapTransport;
  /** Optional live electricity-rate lookup (a provider/tariff API wired at the hub edge). */
  rateFetcher?: RateFetcher;
  /** Cross-process event bus (NATS in prod); defaults to in-process. */
  bus?: IEventBus;
  /** Shared presence store (Redis in prod); defaults to in-process. */
  presence?: IPresenceStore;
  identityStore?: IIdentityStore;
  apiTokenStore?: IApiTokenStore;
  webAuthnStore?: IWebAuthnStore;
  sessionStore?: ISessionStore;
  homeStore?: IHomeStore;
  configStore?: IConfigStore;
  sceneStore?: ISceneStore;
  grantStore?: IGrantStore;
  notificationStore?: INotificationStore;
  driverStore?: IInstalledDriverStore;
  /** § Production Readiness Audit — encryption-at-rest for driver config secret fields
   * (`installed_drivers.config`). Set by bootstrap.ts, keyed from the secrets manager; absent in
   * dev/tests where there's no persisted driver store to protect either. */
  driverSecretCrypto?: DriverSecretCrypto;
  automationStore?: IAutomationStore;
  /** Universal Keypad Framework (§ Universal Keypad Framework) persistence — mappings + feedback subscriptions. */
  keypadMappingStore?: IKeypadMappingStore;
  keypadSubscriptionStore?: IKeypadSubscriptionStore;
  securityStore?: ISecurityStore;
  protocolBindingStore?: IProtocolBindingStore;
  pushTokenStore?: IPushTokenStore;
  /** Backup history store (§ Backup) — enables persisted backups + schedule + health. */
  backupStore?: IBackupStore;
  /** Pending-device queue (§ Device Approval). */
  pendingDeviceStore?: IPendingDeviceStore;
  /** Device provider + lifecycle persistence (ADR-0023). */
  providerStore?: IDeviceProviderStore;
  /** Override push providers (tests); otherwise selected from config. */
  pushProviders?: IPushProvider[];
  /** The underlying SQL database (when persistence is enabled) — for backup/restore, analytics, audit. */
  db?: SqlDb;
  /** Protocol scanners for commissioning (KNX/DALI/Modbus tooling). */
  scanners?: IProtocolScanner[];
  /** Env-configured native driver instances (bootstrap.ts), fed into the unified
   * Driver Lifecycle pipeline alongside manifest-configured ones (§ Driver Lifecycle). */
  envDrivers?: Map<string, INativeProtocolDriver>;
  /** Test-only seam for the KNX installer discovery pipeline (§ InstallerDeps.
   * knxDiscoveryDriverFactory's own doc comment) — omitted in production. */
  knxDiscoveryDriverFactory?: KnxDiscoveryDriverFactory;
  /** Test-only seam (§ InstallerDeps.knxWorkerTimeoutMs) — omitted in production. */
  knxWorkerTimeoutMs?: number;
}

/**
 * Composition root for the hub's Supreme plane (§4, §13). Phase-1 runs the domain
 * services in-process behind their package boundaries; the hub Compose can later
 * split them into separate containers without changing callers. Stores default to
 * in-memory and are swapped for the Postgres-backed repositories (when a database
 * URL is configured) by the bootstrap layer.
 */
export type StateSubscriber = (event: BackendStateEvent) => void;

/** § Decisive KNX Feedback Diagnostic — one bounded snapshot of a device state event
 * at a given hop. Never protocol-specific (any driver's events populate these — KNX
 * is simply the one this pass is investigating), so this adds zero KNX-specific
 * branching to the gateway's core state-fan-out path. */
export interface FeedbackHopSnapshot {
  timestamp: string;
  deviceId: DeviceId;
  state: string;
  value: unknown;
}
export type NotificationSubscriber = (n: Notification) => void;
/** § Realtime State Architecture — a driver connection-state transition, distinct from a
 * device's capability state (StateSubscriber). See DriverStateFrame (supreme-contracts). */
export interface DriverStateEvent {
  driverId: string;
  state: "disconnected" | "connecting" | "connected" | "disconnecting" | "error";
  error?: string | null;
  ts: string;
}
export type DriverStateSubscriber = (event: DriverStateEvent) => void;

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
  /** Universal Keypad Framework (§ Universal Keypad Framework): input→action mapping
   * CRUD + the engine that executes them. */
  keypadMappings!: KeypadMappingService;
  /** Feedback subscription registry: which keypad controls mirror which device+capability. */
  keypadSubscriptions!: SubscriptionManager;
  /** Normalizes raw keypad driver input into protocol-independent events (§ Universal
   * Input Engine), then feeds the bus + the Mapping Engine. */
  private keypadInputEngine!: UniversalInputEngine;
  /** Routes device state changes to every subscribed keypad control's feedback (§
   * Universal Feedback Engine). */
  private keypadFeedbackEngine!: UniversalFeedbackEngine;
  /** Universal Intent & Capability Engine (§ Phase 2, ADR 0017): the extensible
   * catalog of protocol-independent Intents (`GET /v1/intents`). */
  intentRegistry!: IntentRegistry<IntentEngineExecutors>;
  /** Resolves an Intent + target into a concrete command against whichever
   * device capability satisfies it, then dispatches it — the Capability Engine. */
  intentEngine!: IntentEngine;
  /** Capability Resolution index backing the Intent Engine — kept in sync via
   * `HomeService.onDeviceChanged`, never a linear re-scan per lookup. */
  private capabilityIndex!: CapabilityIndex;
  analytics: AnalyticsService | null = null;
  audit: AuditService | null = null;
  /** § Decisive KNX Feedback Diagnostic — bounded (one entry per device, never an
   * unbounded log), in-memory snapshots of the three hops downstream of the driver
   * that no per-protocol provider/driver can see on its own: the raw event this
   * gateway received from the SIL, the same event once `home.applyState()` has
   * actually persisted it, and the same event once it has actually been published to
   * the bus that drives WSS fan-out. Populated for EVERY device (cheap: an object
   * assignment per state event, no protocol branching), read only by the diagnostic
   * endpoint for a specific deviceId — never continuously logged to disk. */
  private readonly lastBackendState = new Map<DeviceId, FeedbackHopSnapshot>();
  private readonly lastPersistedState = new Map<DeviceId, FeedbackHopSnapshot>();
  private readonly lastWebSocketBroadcast = new Map<DeviceId, FeedbackHopSnapshot>();
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
  /** Local HomeKit (HAP) bridge when a transport is configured; null otherwise. */
  homekit: HapBridge | null = null;
  /** Occupancy (vacation) simulation runner — toggles lights to look lived-in while away. */
  readonly occupancy: OccupancyRunner;
  /** Durable per-home settings (energy tariff, etc.). */
  readonly homeConfig: IConfigStore;
  /** Fires scheduled scenes (time / sunrise / sunset) on the minute tick. */
  readonly sceneScheduler: SceneScheduler;
  /** Applies the climate program's setpoint to thermostats on the minute tick. */
  readonly climateRunner: ClimateProgramRunner;
  /** Fires per-device HVAC schedule events (§ HVAC Detail Page "Schedule") on the minute tick. */
  readonly climateScheduler: ClimateScheduler;
  /** Evaluates duration-based alert rules (door left open / unlocked, light left on). */
  readonly alertRunner: AlertRuleRunner;
  /** Pauses/resumes deferrable loads to avoid peak-rate hours (§16). */
  readonly loadShiftRunner: LoadShiftRunner;
  /** Adaptive ventilation: runs a fan from an air-quality sensor with hysteresis (§16). */
  readonly ventilationRunner: VentilationRunner;
  /** Optional live electricity-rate lookup; null = use the curated table / manual rate. */
  readonly rateFetcher: RateFetcher | null;
  /** Estimates energy for non-metered devices from on-time × rated watts (§16). */
  readonly consumptionEstimator: ConsumptionEstimator;
  /** Warns once a month when projected energy spend tracks over the owner's budget (§16). */
  readonly budgetMonitor: BudgetMonitor;
  /** Supreme Intelligence Engine runner — presence fusion + energy decisions under Auto Pilot (ADR 0013). */
  readonly sie: SieRunner;
  /** Local SIE learning/action history store (present only with the Postgres persistence layer). */
  intelligence: IntelligenceRepo | null = null;
  homeId!: HomeId;
  /** True on production first boot until the Setup Wizard creates the administrator.
   * While true, only /healthz and /v1/setup are functional (no demo home is seeded). */
  setupRequired = false;

  private ready = false;
  private readonly deps: AppDeps;
  private readonly stateSubs = new Set<StateSubscriber>();
  private readonly notifySubs = new Set<NotificationSubscriber>();
  private readonly driverStateSubs = new Set<DriverStateSubscriber>();
  /** Last value seen per event-sensor (deviceId:measure) for rising-edge detection. */
  private readonly lastEventValue = new Map<string, number>();

  private constructor(readonly config: GatewayConfig, deps: AppDeps = {}) {
    this.deps = deps;
    this.db = deps.db ?? null;
    this.bus = deps.bus ?? new InProcessEventBus();
    this.presence = deps.presence ?? new InMemoryPresenceStore();
    this.matter = deps.matter ?? null;
    this.voicePublisher = deps.voicePublisher ?? null;
    this.rateFetcher = deps.rateFetcher ?? null;
    this.occupancy = new OccupancyRunner({
      command: (deviceId, on) => this.sil.command(deviceId as DeviceId, { capability: "onoff", action: on ? "on" : "off" }),
    });
    this.homeConfig = deps.configStore ?? new InMemoryConfigStore();
    this.sceneScheduler = new SceneScheduler({
      getSchedules: async () => ((await this.homeConfig.get(this.homeId, "scene_schedules")) as SceneSchedule[] | undefined) ?? [],
      getLocation: async () => (await this.homeConfig.get(this.homeId, "location")) as { lat: number; lon: number } | undefined,
      activate: (sceneId) => this.scenes.activate(sceneId as SceneId).then(() => undefined),
    });
    this.climateRunner = new ClimateProgramRunner({
      getProgram: async () => (await this.homeConfig.get(this.homeId, "climate_program")) as ClimateProgram | undefined,
      applySetpoint: async (targetC) => {
        for (const d of await this.home.listDevices()) {
          if (d.capabilities.some((c) => c.kind === "temperature")) {
            await this.sil.command(d.id, { capability: "temperature", targetC });
          }
        }
      },
    });
    this.climateScheduler = new ClimateScheduler({
      getEvents: async () => ((await this.homeConfig.get(this.homeId, "climate_schedule_events")) as ClimateScheduleEvent[] | undefined) ?? [],
      getHolidayDeviceIds: async () => ((await this.homeConfig.get(this.homeId, "climate_holiday_device_ids")) as string[] | undefined) ?? [],
      onOnceFired: async (eventId) => {
        const events = ((await this.homeConfig.get(this.homeId, "climate_schedule_events")) as ClimateScheduleEvent[] | undefined) ?? [];
        await this.homeConfig.set(this.homeId, "climate_schedule_events", events.map((e) => (e.id === eventId ? { ...e, enabled: false } : e)));
      },
      apply: (deviceId, targetC, mode, fanSpeed) =>
        this.sil
          .command(deviceId as DeviceId, { capability: "temperature", targetC, mode, ...(fanSpeed ? { advanced: { fanSpeed } } : {}) })
          .then(() => undefined),
    });
    this.alertRunner = new AlertRuleRunner({
      getRules: async () => ((await this.homeConfig.get(this.homeId, "alert_rules")) as AlertRule[] | undefined) ?? [],
      getDevice: async (deviceId) => {
        const d = await this.home.getDevice(deviceId as DeviceId);
        return d ? { name: d.name, state: d.state as Record<string, unknown> } : null;
      },
      notify: (message) =>
        this.notifications.create({ homeId: this.homeId, level: "warning", title: "Home alert", body: message }).then(() => undefined),
    });
    this.loadShiftRunner = new LoadShiftRunner({
      getTariff: async () => (await this.homeConfig.get(this.homeId, "tariff")) as Tariff | undefined,
      getDeferrableDeviceIds: async () => ((await this.homeConfig.get(this.homeId, "deferrable_loads")) as string[] | undefined) ?? [],
      getCeiling: async () => (await this.homeConfig.get(this.homeId, "load_shift_ceiling")) as number | undefined,
      setDeviceOn: (deviceId, on) => this.sil.command(deviceId as DeviceId, { capability: "onoff", action: on ? "on" : "off" }),
    });
    this.ventilationRunner = new VentilationRunner({
      getConfig: async () => (await this.homeConfig.get(this.homeId, "ventilation")) as VentilationConfig | undefined,
      readSensor: async (deviceId) => {
        const d = await this.home.getDevice(deviceId as DeviceId);
        const s = d?.state?.sensor as { value?: number } | undefined;
        return typeof s?.value === "number" ? s.value : undefined;
      },
      setFan: (deviceId, on) => this.sil.command(deviceId as DeviceId, { capability: "onoff", action: on ? "on" : "off" }),
    });
    this.consumptionEstimator = new ConsumptionEstimator({
      getWatts: async () => ((await this.homeConfig.get(this.homeId, "device_watts")) as Record<string, number> | undefined) ?? {},
      isOn: async (deviceId) => {
        const d = await this.home.getDevice(deviceId as DeviceId);
        return Boolean((d?.state?.onoff as { on?: boolean } | undefined)?.on);
      },
      roomOf: async (deviceId) => this.home.roomOf(deviceId as DeviceId),
      record: (deviceId, roomId, kwh) =>
        this.analytics?.record({ homeId: this.homeId, deviceId: deviceId as DeviceId, roomId: roomId as never, measure: "energy", value: kwh, unit: "kWh" }) ?? Promise.resolve(),
    });
    this.budgetMonitor = new BudgetMonitor({
      getBudget: async () => (await this.homeConfig.get(this.homeId, "energy_budget")) as EnergyBudget | undefined,
      getRate: async () => (await this.homeConfig.get(this.homeId, "energy_provider")) as { ratePerKwh: number; currency: string } | undefined,
      monthToDateKwh: async (fromIsoDay) => {
        if (!this.analytics) return 0;
        const days = await this.analytics.energyDailySeries(this.homeId, fromIsoDay);
        return days.reduce((sum, d) => sum + d.kwh, 0);
      },
      notify: (message) =>
        this.notifications.create({ homeId: this.homeId, level: "warning", title: "Energy budget", body: message }).then(() => undefined),
    });
    // Supreme Intelligence Engine (ADR 0013): presence fusion + energy decisions under Auto Pilot,
    // recording every action to the local learning/history store. All logic is in @supreme/intelligence.
    this.sie = new SieRunner({
      homeId: this.homeId, // closures below resolve homeId lazily at tick time
      getZones: async () => ((await this.homeConfig.get(this.homeId, "sie_zones")) as Zone[] | undefined) ?? [],
      onlineUserIds: () => this.presence.online(this.homeId),
      listDevices: async () => {
        const watts = ((await this.homeConfig.get(this.homeId, "device_watts")) as Record<string, number> | undefined) ?? {};
        const intelMap = ((await this.homeConfig.get(this.homeId, "device_intel")) as Record<string, DeviceIntel> | undefined) ?? {};
        const devices = await this.home.listDevices();
        return devices.map((d) => ({
          id: d.id,
          name: d.name,
          roomId: d.roomId,
          on: Boolean((d.state?.onoff as { on?: boolean } | undefined)?.on),
          watts: watts[d.id],
          intel: intelMap[d.id],
        }));
      },
      getSettings: async () => ((await this.homeConfig.get(this.homeId, "sie_autopilot")) as AutoPilotSettings | undefined) ?? { mode: "notify_only" },
      setSettings: (s) => this.homeConfig.set(this.homeId, "sie_autopilot", s),
      getRate: async () => (await this.homeConfig.get(this.homeId, "energy_provider")) as { ratePerKwh: number; currency: string } | undefined,
      getSuggestionStates: async () => ((await this.homeConfig.get(this.homeId, "sie_suggestion_states")) as Record<string, SuggestionState> | undefined) ?? {},
      setSuggestionStates: (m) => this.homeConfig.set(this.homeId, "sie_suggestion_states", m),
      command: (deviceId, on) => this.sil.command(deviceId as DeviceId, { capability: "onoff", action: on ? "on" : "off" }).then(() => undefined),
      notify: (input) => this.notifications.create({ homeId: this.homeId, level: input.level, title: input.title, body: input.body, context: input.context }).then(() => undefined),
      recordHistory: async (h) => {
        if (!this.intelligence) return;
        const c = h.confidence;
        await this.intelligence.record({
          id: newId("sie"),
          homeId: this.homeId,
          ts: new Date().toISOString(),
          module: h.module,
          deviceId: h.deviceId ?? null,
          roomId: h.roomId ?? null,
          zoneId: h.zoneId ?? null,
          ownerUserId: h.ownerUserId ?? null,
          action: h.action,
          reason: h.reason ?? null,
          automatic: h.automatic,
          userResponse: h.userResponse ?? null,
          decisionConfidence: c?.decision ?? null,
          presenceConfidence: c?.presence ?? null,
          roomVacancyConfidence: c?.roomVacancy ?? null,
          ownershipConfidence: c?.ownership ?? null,
          energyConfidence: c?.energy ?? null,
          estimatedWatts: h.estimatedWatts ?? null,
          estimatedKwhSaved: h.estimatedKwhSaved ?? null,
          estimatedCostSaved: h.estimatedCostSaved ?? null,
          currency: h.currency ?? null,
          metadata: h.metadata ?? {},
        });
      },
    });
    this.identity = new IdentityService({
      tokenSecret: config.tokenSecret,
      store: deps.identityStore,
      sessionStore: deps.sessionStore,
      apiTokenStore: deps.apiTokenStore,
      webAuthnStore: deps.webAuthnStore,
      ...(config.webAuthnRpId ? { webAuthn: { rpId: config.webAuthnRpId, rpName: "Supreme OS", origin: config.webAuthnOrigin } } : {}),
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
    await this.bus.subscribe<DriverStateEvent>("supreme.home.*.driver.state", (event) => {
      for (const sub of this.driverStateSubs) sub(event);
    });
  }

  /** Publish a driver connection-state transition (§ Realtime State Architecture) — the
   * bus fan-out drives WSS delivery identically to device state/notifications (in-process
   * today, cross-process under NATS). Called from the generic connect/disconnect handlers
   * and the driver lifecycle pipeline (installer-context.ts), never per-driver-type code. */
  async publishDriverState(driverId: string, state: DriverStateEvent["state"], error?: string | null): Promise<void> {
    await this.bus.publish(subjects.driverState(this.homeId), {
      driverId, state, error: error ?? null, ts: new Date().toISOString(),
    } satisfies DriverStateEvent);
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
    // Default developer account (DEV BUILDS ONLY): logging in as `supreme` / `supreme@72` gives a
    // full-access master with Developer Mode already on (SUPREME_DEV_MODE). NEVER seeded in
    // production — guarded by config.devMode, which production builds never set.
    if (config.devMode) await ctx.ensureDeveloperAccount();
    return ctx;
  }

  /** Seed the built-in Supreme developer account on dev builds (idempotent). */
  private async ensureDeveloperAccount(): Promise<void> {
    try {
      await this.identity.createUser({
        email: "supreme@supreme.local",
        password: "supreme@72",
        displayName: "Supreme Developer",
        userType: "master",
      });
    } catch {
      // Already exists (or home not commissioned) — fine; this is best-effort dev convenience.
    }
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
      driverSecretCrypto: deps.driverSecretCrypto,
      db: deps.db,
      scanners: deps.scanners,
      protocolBindingStore: deps.protocolBindingStore,
      backupStore: deps.backupStore,
      pendingDeviceStore: deps.pendingDeviceStore,
      configStore: this.homeConfig,
      envDrivers: deps.envDrivers,
      bus: this.bus,
      knxDiscoveryDriverFactory: deps.knxDiscoveryDriverFactory,
      knxWorkerTimeoutMs: deps.knxWorkerTimeoutMs,
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

    // Universal Intent & Capability Engine (§ Phase 2, ADR 0017): the Capability
    // Index is populated from the current device topology and kept in sync via
    // HomeService's change event — never a linear re-scan of every device per
    // lookup, only ever the (small) set of devices actually touched.
    this.capabilityIndex = new CapabilityIndex();
    this.capabilityIndex.hydrate(await this.home.listDevices());
    this.home.onDeviceChanged((event) => {
      if (event.type === "upsert") this.capabilityIndex.upsert(event.device);
      else this.capabilityIndex.remove(event.deviceId);
    });
    this.intentRegistry = new IntentRegistry<IntentEngineExecutors>();
    registerBuiltinIntents(this.intentRegistry);
    this.intentEngine = new IntentEngine({
      registry: this.intentRegistry,
      capabilityIndex: this.capabilityIndex,
      executors: {
        command: (deviceId, command) => this.sil.command(deviceId, command),
        getState: (deviceId, capability) => this.sil.getState(deviceId, capability),
        getCapabilityConfig: (deviceId, capability) => this.sil.getCapabilityConfig(deviceId, capability),
        activateScene: async (sceneId) => {
          await this.scenes.activate(sceneId);
        },
        runAutomation: async (automationId) => {
          await this.automations.testRun(automationId);
        },
        notify: async (input) => {
          await this.notifications.create({ homeId: this.homeId, userId: input.userId, level: input.level, title: input.title, body: input.body });
        },
        security: {
          arm: async (mode) => {
            this.security.arm(this.homeId, mode, null);
          },
          disarm: async () => {
            this.security.disarm(this.homeId, null);
          },
          panic: async () => {
            this.security.trigger(this.homeId);
          },
        },
      },
    });

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
      // § Universal Intent & Capability Engine: an `"intent"` AutomationAction
      // (available to BOTH the Automation Engine and the Keypad Mapping Engine,
      // since they already share this exact executor set) resolves and runs
      // through the SAME Intent Engine a direct `POST /v1/intents/:id/run` uses.
      runIntent: async (intentId, target, params) => {
        await this.intentEngine.run(intentId, target, params);
      },
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
    // § ADR 0101 Part 1 — scenes execute through this SAME engine from here on (never a second
    // execution path); attached post-construction since scenes are built before automations.
    this.scenes.attachEngine(engine);

    // Universal Keypad Framework (§ Universal Keypad Framework): the Mapping Engine
    // reuses the SAME executors as the Automation Engine above — a keypad mapping's
    // actions ARE automation actions, by design (see `KeypadMapping` in
    // `@supreme/domain-model`), so there is exactly one "run a Supreme action"
    // implementation for the gateway to wire up, not two.
    const keypadMappingEngine = new KeypadMappingEngine({
      executors,
      onRun: (id, ok) => {
        void this.audit?.record({
          homeId: this.homeId,
          action: ok ? "keypad_mapping.run" : "keypad_mapping.error",
          resourceType: "keypad_mapping",
          resourceId: id,
        });
      },
    });
    this.keypadMappings = new KeypadMappingService(keypadMappingEngine, deps.keypadMappingStore);
    await this.keypadMappings.start();

    this.keypadSubscriptions = new SubscriptionManager(deps.keypadSubscriptionStore ?? new InMemoryKeypadSubscriptionStore());
    await this.keypadSubscriptions.hydrate();

    // Universal Feedback Engine (§ Feedback Routing): every state change already flows
    // through `onBackendState` below; this just fans it out to subscribed keypad
    // controls via the SIL's keypad seam, never a protocol write directly.
    this.keypadFeedbackEngine = new UniversalFeedbackEngine({
      subscriptions: this.keypadSubscriptions,
      getKeypadCapabilities: (keypadId) => this.sil.getKeypadCapabilities(keypadId),
      sendFeedback: (command) => this.sil.sendKeypadFeedback(command),
    });

    // Universal Input Engine (§ Universal Input Engine): normalizes every keypad-
    // capable driver's raw/derived input, publishes it for cross-process WSS-style
    // fan-out on the bus, and drives the Mapping Engine.
    this.keypadInputEngine = new UniversalInputEngine({
      publish: (event) => {
        void this.bus.publish(subjects.keypadInput(this.homeId), event);
        void this.keypadMappings.onInputEvent(event);
      },
    });
    this.sil.subscribeKeypadInput((event) => this.keypadInputEngine.ingest(event));

    if (deps.db) {
      this.analytics = new AnalyticsService(deps.db);
      this.audit = new AuditService(deps.db);
      this.intelligence = new IntelligenceRepo(deps.db);
    }

    // Local HomeKit (Apple Home / Siri) bridge — opt-in, runs entirely on the hub. Present only when
    // a HAP transport is injected; we offer every device as an accessory (HapBridge itself skips
    // publishing one with no mapped HAP service at all — § Never publish an empty accessory) and
    // route HomeKit writes back through the SIL (identity/RBAC enforced as for any command).
    if (deps.homekitTransport) {
      const bridge = new HapBridge({
        transport: deps.homekitTransport,
        onCommand: (deviceId, command) => this.sil.command(deviceId as DeviceId, hapToCapabilityCommand(command)),
      });
      for (const device of await this.home.listDevices()) {
        bridge.addDevice({ id: device.id, name: device.name, capabilities: device.capabilities.map((c) => c.kind) });
      }
      await bridge.start();
      this.homekit = bridge;
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
    email: string;
    password: string;
    displayName?: string;
    systemName: string;
    location?: string | null;
    timeZone?: string | null;
  }): Promise<{ login: LoginResponse; loginEmail: string }> {
    if (!this.setupRequired) {
      throw new SupremeError("conflict", "Supreme OS is already set up");
    }
    // § live-confirmed fix — a real, mandatory email is now required by the route
    // above; no synthesized "@supreme.local" fallback, since password recovery needs a
    // real address to send a reset to and a fabricated one silently defeats that.
    const loginEmail = input.email;
    const { home } = await this.identity.commission({
      homeName: input.systemName || "Supreme Residence",
      email: loginEmail,
      password: input.password,
      displayName: input.displayName?.trim() || input.username,
    });
    // identity.commission() persists the home via the IDENTITY store; HomeService (which
    // /v1/home, /v1/rooms, /v1/devices all read from) has its own store and never learns
    // about it otherwise. In production both stores happen to share one Postgres `homes`
    // table, masking this — but dev/test's in-memory stores are genuinely separate, so
    // every home-scoped endpoint 404s "home not commissioned" forever without this.
    await this.home.setHome(home);
    await this.initWithHome(home);
    this.setupRequired = false;
    const login = await this.identity.login(loginEmail, input.password);
    return { login, loginEmail };
  }

  /** Handle a normalized backend state delta: cache, fan-out, automations, analytics. */
  private async onBackendState(event: BackendStateEvent): Promise<void> {
    // § Decisive KNX Feedback Diagnostic, hop 1 — the raw event this gateway received
    // from the SIL, BEFORE persistence/broadcast. If this never updates for a device
    // on a physical keypad press, the break is upstream (driver → native adapter →
    // SIL), not in this gateway at all.
    this.recordFeedbackHop(this.lastBackendState, event);
    await this.home.applyState(event.deviceId, event.state);
    // § Decisive KNX Feedback Diagnostic, hop 2 — recorded only once `applyState()`
    // above has actually returned, so a nonzero snapshot here is proof the state
    // reached HomeService's store, not just that this method was called.
    this.recordFeedbackHop(this.lastPersistedState, event);
    // Publish to the bus; the bus subscription (subscribeBus) drives WSS fan-out —
    // in-process today, cross-process under NATS.
    await this.bus.publish(subjects.deviceState(this.homeId), event);
    // § Decisive KNX Feedback Diagnostic, hop 3 — recorded only once the bus publish
    // above has actually returned. The bus is what drives WSS delivery (see
    // `subscribeBus()`), so this is the closest honest proxy for "reached WSS" this
    // gateway can report without instrumenting every individual socket write.
    this.recordFeedbackHop(this.lastWebSocketBroadcast, event);
    // § AVR Diagnostic Mode — append the `[Gateway]` stage to whichever driver started this
    // event's correlation-ID trace (see `BackendStateEvent.traceId`). `undefined` for every
    // event from every driver that doesn't opt in, so this is a no-op for the entire fleet
    // except AVR-with-diagnostics-on. `getNativeDriver("avr")` returns the SAME driver
    // instance that emitted the event, since only one driver owns the "avr" protocol slot.
    if (event.traceId) {
      this.sil.getNativeDriver("avr")?.recordDiagnosticStage?.(event.traceId, "Gateway", { published: true });
    }
    if (!this.ready) return;
    // Proactive voice reporting: tell the cloud (debounced) so Alexa/Google stay in sync (ADR 0010).
    this.voicePublisher?.publish(event);
    // Local HomeKit: push the change to the bridge so Apple Home reflects it.
    this.homekit?.pushState(event.deviceId, event.capability, event.state as unknown as Record<string, unknown>);
    await this.maybeNotifyEvent(event);
    await this.automations.onDeviceState({
      deviceId: event.deviceId,
      capability: event.capability,
      state: event.state,
    });
    await this.keypadFeedbackEngine.onDeviceState({
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

  /** § Decisive KNX Feedback Diagnostic — records one bounded (single-entry-per-device)
   * snapshot; never appends, never grows unbounded. */
  private recordFeedbackHop(map: Map<DeviceId, FeedbackHopSnapshot>, event: BackendStateEvent): void {
    map.set(event.deviceId, {
      timestamp: new Date().toISOString(),
      deviceId: event.deviceId,
      state: event.state.kind,
      value: event.state,
    });
  }

  /** § Decisive KNX Feedback Diagnostic — the full cross-hop snapshot for one device: this
   * gateway's own three hops (above) plus, when the device is KNX-managed, that driver's
   * own provider/binding-level diagnostics (§ Pass 20/23 and the KNX Ultimate Provider's
   * "Live Feedback Diagnostic Pass" counters). `knx: null` for a non-KNX device — never
   * fabricated. This is the single call a human tester hits after a physical keypad press
   * to see, in one response, exactly which of the 7 hops (bus → provider → driver →
   * gateway-backend → gateway-persisted → gateway-broadcast → frontend) actually moved. */
  getFeedbackDiagnostics(deviceId: DeviceId): {
    lastBackendState: FeedbackHopSnapshot | null;
    lastPersistedState: FeedbackHopSnapshot | null;
    lastWebSocketBroadcast: FeedbackHopSnapshot | null;
    // `SupremeIntegrationLayer.getKnxFeedbackDiagnostics` (§ Live Feedback Diagnostic
    // Pass) is the SIL-level passthrough to `SupremeKnxDriver.knxFeedbackDiagnostics` —
    // reused here rather than re-deriving provider/binding diagnostics a second time.
    knx: unknown | null;
  } {
    return {
      lastBackendState: this.lastBackendState.get(deviceId) ?? null,
      lastPersistedState: this.lastPersistedState.get(deviceId) ?? null,
      lastWebSocketBroadcast: this.lastWebSocketBroadcast.get(deviceId) ?? null,
      knx: this.sil.getKnxFeedbackDiagnostics(deviceId),
    };
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
  onDriverState(sub: DriverStateSubscriber): () => void {
    this.driverStateSubs.add(sub);
    return () => this.driverStateSubs.delete(sub);
  }

  roomOf(deviceId: DeviceId): Promise<string | null> {
    return this.home.roomOf(deviceId);
  }

  /** Proactively expire time-limited users whose window has passed; audit each (§8). */
  async sweepExpiredAccess(): Promise<void> {
    const expired = await this.identity.sweepExpired();
    for (const userId of expired) {
      await this.audit?.record({ homeId: this.homeId, action: "user.expired", resourceType: "user", resourceId: userId });
    }
  }

  async shutdown(): Promise<void> {
    this.occupancy.stop();
    this.voicePublisher?.stop();
    await this.homekit?.stop();
    await this.security.flush();
    await this.sil.stop();
    await this.bus.close();
    await this.presence.close();
  }
}

/** Map a HomeKit-derived command to the Supreme CapabilityCommand the SIL validates. */
function hapToCapabilityCommand(c: HapCommand): CapabilityCommand {
  switch (c.capability) {
    case "onoff":
      return { capability: "onoff", action: c.action };
    case "brightness":
      return { capability: "brightness", action: "set", level: c.level };
    case "color":
      return { capability: "color", ...(c.hue !== undefined ? { hue: c.hue } : {}), ...(c.saturation !== undefined ? { saturation: c.saturation } : {}), ...(c.kelvin !== undefined ? { kelvin: c.kelvin } : {}) };
    case "lock":
      return { capability: "lock", action: c.action };
    case "position":
      return { capability: "position", action: "set", position: c.position };
    case "temperature":
      return { capability: "temperature", targetC: c.targetC };
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
  void config;
  return new SupremeIntegrationLayer({ adapter: new MockAdapter() });
}
