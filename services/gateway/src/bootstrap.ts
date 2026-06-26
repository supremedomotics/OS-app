import {
  EntityRegistryMirror,
  HaAdapter,
  HaWsTransport,
  MigrationPolicy,
  MockAdapter,
  RoutingBackendAdapter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type IBackendAdapter,
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
  createSonosConnect,
  createAppleTvConnect,
} from "@supreme/protocols";
import { createPersistence } from "@supreme/persistence";
import { createEventBus, createPresenceStore } from "@supreme/messaging";
import { HttpProtocolScanner } from "@supreme/commissioning";
import type { ProtocolKind } from "@supreme/domain-model";
import { assertSecureConfig, type GatewayConfig } from "./config.js";
import { AppContext, type AppDeps } from "./context.js";

/**
 * Hub boot edge. This is where the concrete, HA-specific WebSocket transport is
 * assembled and injected into the SIL — the only place in the codebase that wires
 * the loopback HA URL + long-lived token (both held inside the SIL). It is also
 * where the Postgres-backed stores are connected and migrated. Everything above
 * receives a ready {@link AppContext} and never learns a backend or DB exists.
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
    deps.homeStore = stores.home;
    deps.sceneStore = stores.scenes;
    deps.grantStore = stores.grants;
    deps.notificationStore = stores.notifications;
    deps.driverStore = stores.drivers;
    deps.automationStore = stores.automations;
    deps.securityStore = stores.security;
    deps.protocolBindingStore = stores.protocolBindings;
    deps.pushTokenStore = stores.pushTokens;
    migrationStore = stores.migrationPolicy;
    deps.db = stores.db;
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

  // The SIL is always backed by a routing adapter so per-domain native migration
  // (§16 Phase 4) is available: the "ha" side is the real HaAdapter or the mock
  // backend, and the native side is the Supreme-native engine. The shared registry
  // is what the router consults to route each domain.
  const registry = new EntityRegistryMirror();
  let haSide: IBackendAdapter;
  if (config.backend === "ha") {
    if (!config.haToken) throw new Error("SUPREME_BACKEND=ha requires SUPREME_HA_TOKEN");
    const transport = new HaWsTransport({ url: config.haUrl, token: config.haToken });
    haSide = new HaAdapter({ transport, registry });
  } else {
    haSide = new MockAdapter();
  }
  // Real native protocol stacks the Supreme-native engine fronts (§3, §7). Loaded
  // only when configured; the in-process model serves everything else, so the hub
  // boots identically with or without field-bus hardware present.
  const nativeDrivers: INativeProtocolDriver[] = [];
  if (config.mqttUrl) nativeDrivers.push(new MqttProtocolDriver({ url: config.mqttUrl }));
  if (config.modbusHost) {
    nativeDrivers.push(new ModbusProtocolDriver({ host: config.modbusHost, port: config.modbusPort }));
  }
  if (config.knxHost) {
    nativeDrivers.push(new KnxProtocolDriver({ host: config.knxHost, port: config.knxPort }));
  }
  // Matter is opt-in (blueprint §9: ships disabled). It needs the on-box Matter
  // controller subsystem; until that's provisioned the driver stays disconnected and
  // boot is unaffected (the native engine tolerates a driver that can't connect).
  if (config.matterEnabled) {
    nativeDrivers.push(new MatterProtocolDriver({ storagePath: config.matterStoragePath || undefined }));
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
    nativeDrivers.push(new AvrProtocolDriver());
  }
  // CoolMasterNet HVAC bridge — VRF/VRV indoor units over the CoolAutomation bridge.
  if (config.coolMasterHost) {
    nativeDrivers.push(new CoolMasterProtocolDriver({ host: config.coolMasterHost }));
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

  // Restore persisted native-migration routing so migrated domains stay native on reboot.
  const policy = new MigrationPolicy([], migrationStore);
  await policy.hydrate();
  const router = new RoutingBackendAdapter({
    ha: haSide,
    native: new SupremeNativeAdapter({ drivers: nativeDrivers }),
    registry,
    policy,
  });
  deps.sil = new SupremeIntegrationLayer({ adapter: router, registry });

  return AppContext.create(config, deps);
}
