import {
  EntityRegistryMirror,
  MigrationPolicy,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  ProviderRegistry,
  DriverBindingEngine,
  type INativeProtocolDriver,
  type IMigrationPolicyStore,
} from "@supreme/integration-layer";
import {
  MqttProtocolDriver,
  ModbusProtocolDriver,
  KnxProtocolDriver,
  MatterProtocolDriver,
  ZigbeeProtocolDriver,
  DaliProtocolDriver,
  AvrProtocolDriver,
  HeosProtocolDriver,
  YamahaProtocolDriver,
  CoolMasterProtocolDriver,
  SipProtocolDriver,
  WiimProtocolDriver,
  DevialetProtocolDriver,
  SonosProtocolDriver,
  AjaxProtocolDriver,
  ShellyProtocolDriver,
  AirPlayProtocolDriver,
  AppleTvProtocolDriver,
  LutronProtocolDriver,
  TuyaProtocolDriver,
  CasambiProtocolDriver,
  MatterFabricManager,
  HttpMatterFabricSync,
  createSonosConnect,
  createAppleTvConnect,
} from "@supreme/protocols";
import { createPersistence, migrateOwnershipToProvider } from "@supreme/persistence";
import { createEventBus, createPresenceStore } from "@supreme/messaging";
import { HttpProtocolScanner } from "@supreme/commissioning";
import type { ProtocolKind } from "@supreme/domain-model";
import { assertSecureConfig, type GatewayConfig } from "./config.js";
import { AppContext, type AppDeps } from "./context.js";
import { VoiceStatePublisher } from "./voice-publisher.js";

/**
 * Hub boot edge. This is where the Postgres-backed stores are connected and
 * migrated. Everything above receives a ready {@link AppContext} and never
 * learns a backend or DB exists.
 *
 * Defaults (no DATABASE_URL, SUPREME_BACKEND=mock) give the standalone slice used
 * in dev and tests: in-memory stores + the mock backend.
 */
export async function createHubContext(config: GatewayConfig): Promise<AppContext> {
  // Fail closed: never boot a production hub with insecure defaults.
  assertSecureConfig(config);
  const deps: AppDeps = {};
  let migrationStore: IMigrationPolicyStore | undefined;

  if (config.databaseUrl) {
    const stores = await createPersistence({ connectionString: config.databaseUrl });
    deps.identityStore = stores.identity;
    deps.sessionStore = stores.sessions;
    deps.apiTokenStore = stores.apiTokens;
    deps.webAuthnStore = stores.webAuthn;
    deps.homeStore = stores.home;
    deps.configStore = stores.config;
    deps.sceneStore = stores.scenes;
    deps.grantStore = stores.grants;
    deps.notificationStore = stores.notifications;
    deps.driverStore = stores.drivers;
    deps.automationStore = stores.automations;
    deps.securityStore = stores.security;
    deps.protocolBindingStore = stores.protocolBindings;
    deps.pushTokenStore = stores.pushTokens;
    deps.backupStore = stores.backups;
    deps.pendingDeviceStore = stores.pendingDevices;
    deps.providerStore = stores.deviceProvider;
    migrationStore = stores.migrationPolicy;
    deps.db = stores.db;

    // ADR-0023 § Migration: one-time, idempotent device_ownership -> device_provider
    // upgrade. Cheap to run every boot (a no-op once every device is migrated) —
    // never fabricates a bound state, only records provenance; see migrate-ownership.ts.
    const ownershipMigration = await migrateOwnershipToProvider(stores.deviceOwnership, stores.deviceProvider);
    if (ownershipMigration.migrated.length || ownershipMigration.unresolvable.length) {
      console.info("[ADR-0023 migration] device_ownership -> device_provider", {
        migrated: ownershipMigration.migrated.length,
        skippedAlreadyMigrated: ownershipMigration.skippedAlreadyMigrated.length,
        unresolvable: ownershipMigration.unresolvable,
      });
    }
  }

  // Cross-process messaging: NATS event bus + Redis presence when configured,
  // otherwise the in-process defaults (dev/tests). Selected once here at the boot edge.
  deps.bus = await createEventBus({ natsUrl: config.natsUrl, redisUrl: config.redisUrl });
  deps.presence = await createPresenceStore({ natsUrl: config.natsUrl, redisUrl: config.redisUrl });

  // Register protocol scanners (KNX/DALI/Modbus) backed by the Python tooling.
  if (config.commissioningUrl) {
    const protocols: ProtocolKind[] = ["knx", "dali", "modbus"];
    deps.scanners = protocols.map(
      (protocol) => new HttpProtocolScanner({ protocol, baseUrl: config.commissioningUrl }),
    );
  }

  // ADR-0023 § Native Backend: the SIL is always backed by a ProviderRouter, whose
  // engine hosts every native protocol driver directly — no external backend leg.
  const registry = new EntityRegistryMirror();
  const nativeDrivers: INativeProtocolDriver[] = [];
  // config.backend === "mock" registers nothing here — MockAdapter exists only for
  // standalone/dev slices (see buildSil in context.ts), never wired into a real hub.
  // Real native protocol stacks the Supreme-native engine fronts (§3, §7). Loaded
  // only when configured; the hub boots identically with or without field-bus
  // hardware present — an unconfigured protocol simply never appears in this array.
  if (config.mqttUrl) nativeDrivers.push(new MqttProtocolDriver({ url: config.mqttUrl }));
  if (config.modbusHost) {
    nativeDrivers.push(new ModbusProtocolDriver({ host: config.modbusHost, port: config.modbusPort }));
  }
  if (config.knxHost) {
    nativeDrivers.push(new KnxProtocolDriver({ host: config.knxHost, port: config.knxPort }));
  }
  // Matter is opt-in (blueprint §9: ships disabled). It needs the on-box Matter
  // controller subsystem; until that's provisioned the driver stays disconnected and
  // boot is unaffected (the native engine tolerates a driver that can't connect). When
  // enabled we keep a handle so the Matter routes can pair devices by setup code and
  // mirror the fabric to the OPTIONAL cloud Matter service (non-fatal if unreachable).
  if (config.matterEnabled) {
    const matterDriver = new MatterProtocolDriver({ storagePath: config.matterStoragePath || undefined });
    nativeDrivers.push(matterDriver);
    const sync =
      config.matterCloudUrl && config.matterCloudApiKey
        ? new HttpMatterFabricSync({ baseUrl: config.matterCloudUrl, apiKey: config.matterCloudApiKey })
        : undefined;
    const fabric = new MatterFabricManager({ driver: matterDriver, homeId: config.homeId, ...(sync ? { sync } : {}) });
    void fabric.start();
    deps.matter = { driver: matterDriver, fabric };
  }
  // Native Zigbee: talks ZCL straight to a coordinator radio (no MQTT/Zigbee2MQTT).
  if (config.zigbeePort) {
    nativeDrivers.push(new ZigbeeProtocolDriver({ port: config.zigbeePort, adapter: config.zigbeeAdapter }));
  }
  // DALI (IEC 62386): addressable architectural lighting over a USB DALI interface.
  if (config.daliPort) {
    nativeDrivers.push(new DaliProtocolDriver({ port: config.daliPort }));
  }
  // AVR (Denon/Marantz) IP control — receivers added by IP address at bind time.
  if (config.avrEnabled) {
    nativeDrivers.push(new AvrProtocolDriver({ diagnostics: config.avrDiagnostics }));
  }
  // HEOS CLI (Denon/Marantz whole-home streaming) — one connection per network reaches
  // every player by pid; the network is added by any one player's IP at bind time.
  if (config.heosEnabled) {
    nativeDrivers.push(new HeosProtocolDriver());
  }
  // Yamaha Extended Control (YXC/MusicCast) — units (standalone streamers or
  // MusicCast-enabled AVRs) added by IP address at bind time; up to 4 zones each.
  if (config.yamahaEnabled) {
    nativeDrivers.push(new YamahaProtocolDriver());
  }
  // CoolMasterNet/CoolLinux HVAC gateway — VRF/VRV indoor units, groups, water heaters,
  // and ventilation over ASCII_IF + REST v2 (see docs/coolmaster/README.md).
  if (config.coolMasterHost) {
    nativeDrivers.push(
      new CoolMasterProtocolDriver({
        host: config.coolMasterHost,
        protocol: config.coolMasterProtocol as "auto" | "ascii" | "rest",
        asciiPort: config.coolMasterAsciiPort,
        restPort: config.coolMasterRestPort,
        pollMs: config.coolMasterPollMs,
        slowPollMs: config.coolMasterSlowPollMs,
        discoveryIntervalMs: config.coolMasterDiscoveryIntervalMs,
        timeoutMs: config.coolMasterTimeoutMs,
        retryCount: config.coolMasterRetryCount,
        debug: config.coolMasterDebug,
      }),
    );
  }
  // SIP door stations — door release (lock) + ring (sensor). Needs a SIP UA subsystem;
  // until provisioned the driver stays disconnected and boot is unaffected.
  if (config.sipServer) {
    nativeDrivers.push(new SipProtocolDriver({ server: config.sipServer }));
  }
  // Streamers / multi-room audio (media) + Ajax security sensors — added by IP/account
  // at bind time. WiiM/Devialet speak real HTTP APIs; Sonos (UPnP) + Ajax (cloud) need
  // a transport/client provisioned, and the native engine tolerates an unconnected one.
  if (config.wiimEnabled) nativeDrivers.push(new WiimProtocolDriver());
  if (config.devialetEnabled) nativeDrivers.push(new DevialetProtocolDriver());
  if (config.sonosEnabled) nativeDrivers.push(new SonosProtocolDriver({ connect: createSonosConnect() }));
  if (config.ajaxEnabled) nativeDrivers.push(new AjaxProtocolDriver());
  // Shelly Gen2 (real local RPC + mDNS discovery); AirPlay (mDNS discovery + sender seam).
  if (config.shellyEnabled) nativeDrivers.push(new ShellyProtocolDriver());
  if (config.airplayEnabled) nativeDrivers.push(new AirPlayProtocolDriver());
  // Apple TV — real mDNS discovery (_mediaremotetv._tcp); full media control + rich
  // now-playing (foreground app + content). Control is fulfilled by the pyatv-backed
  // bridge (services/appletv-py), which holds the per-device pairing credentials; when
  // no bridge URL is set the driver still discovers, and a bind awaits a configured
  // client (boot is unaffected either way).
  if (config.appleTvEnabled) {
    nativeDrivers.push(
      new AppleTvProtocolDriver({
        ...(config.appleTvBridgeUrl
          ? { connect: createAppleTvConnect({ baseUrl: config.appleTvBridgeUrl }) }
          : {}),
        // Advertise client-reachable cover-art URLs (served by the gateway proxy)
        // when a public base URL is configured.
        ...(config.publicBaseUrl
          ? { artworkUrlFor: (id) => `${config.publicBaseUrl}/v1/devices/${id}/media/artwork` }
          : {}),
      }),
    );
  }
  // Lutron LIP — wired (RA2/HomeWorks QS) + wireless (Caséta Smart Bridge Pro), one bridge.
  if (config.lutronHost) {
    nativeDrivers.push(
      new LutronProtocolDriver({ host: config.lutronHost, username: config.lutronUsername, password: config.lutronPassword }),
    );
  }
  // Tuya — proprietary; needs a device client (tuyapi local key / cloud SDK) provisioned.
  if (config.tuyaEnabled) nativeDrivers.push(new TuyaProtocolDriver());
  // Casambi — Bluetooth-mesh luminaires via Casambi Cloud (REST + WebSocket). Enabled only when
  // credentials are provisioned; the key/password come from the sealed secrets store and never log.
  if (config.casambiApiKey && config.casambiEmail && config.casambiPassword) {
    nativeDrivers.push(
      new CasambiProtocolDriver({
        credentials: {
          apiKey: config.casambiApiKey,
          email: config.casambiEmail,
          password: config.casambiPassword,
          ...(config.casambiNetworkId ? { networkId: config.casambiNetworkId } : {}),
        },
      }),
    );
  }

  // Restore persisted migration-wizard routing so a migrated domain's tracked engine
  // survives a reboot — purely the `/v1/migration` reporting surface, not routing.
  const migrationPolicy = new MigrationPolicy([], migrationStore);
  await migrationPolicy.hydrate();
  // The engine starts with NO drivers registered — every env-configured driver built
  // above is instead handed to
  // InstallerServices as `envDrivers` (below) and registered through the same Driver
  // Lifecycle pipeline manifest-configured drivers use (§ Driver Lifecycle: no
  // duplicate registration logic). This is the structural fix for the boot-order race
  // the Architecture Investigation Report identified: a persisted protocol binding can
  // no longer be replayed before the driver it needs exists, because there is only one
  // place drivers get registered + bindings restored.
  const providers = new ProviderRegistry(deps.providerStore);
  const engine = new SupremeNativeAdapter();
  const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
  deps.sil = new SupremeIntegrationLayer({ adapter: router, registry, providers, migrationPolicy });
  deps.envDrivers = new Map(nativeDrivers.map((d) => [d.protocol, d] as const));

  // Proactive voice reporting (ADR 0010): when configured, publish local state changes to the
  // cloud Voice service so Alexa/Google stay in sync. Outbound-only and non-fatal.
  if (config.voiceCloudUrl && config.voiceHubKey) {
    deps.voicePublisher = new VoiceStatePublisher({ baseUrl: config.voiceCloudUrl, hubKey: config.voiceHubKey });
  }

  const ctx = await AppContext.create(config, deps);

  return ctx;
}
