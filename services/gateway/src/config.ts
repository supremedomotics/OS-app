import { existsSync, readFileSync } from "node:fs";

/**
 * Gateway configuration. All values come from the hub environment; sensible
 * local defaults keep the dev/test loop frictionless. Secrets must be provided
 * in production (the hub's sealed store injects them) — see infra/hub-compose.
 *
 * Secrets support the `*_FILE` convention (Docker/Kubernetes secrets): if
 * `SUPREME_TOKEN_SECRET_FILE` points at a readable file, its contents are used in
 * preference to `SUPREME_TOKEN_SECRET` — so plaintext secrets never live in env.
 */
function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file && existsSync(file)) return readFileSync(file, "utf8").trim();
  return env[name];
}
export interface GatewayConfig {
  host: string;
  port: number;
  tokenSecret: string;
  /** "mock" runs the offline vertical slice; "ha" uses the real HA backend. */
  backend: "mock" | "ha";
  haUrl: string;
  haToken: string;
  /** Postgres connection string; empty = use in-memory stores (dev/tests). */
  databaseUrl: string;
  /** Hub software version reported by diagnostics / project export. */
  hubVersion: string;
  /**
   * Trust anchors for the Driver Store + licensing (PEM). When empty, the gateway
   * generates an ephemeral dev keypair and seeds a self-signed first-party catalog
   * so the driver store is exercisable locally. Production injects the real Supreme
   * store + licensing public keys at the hub boot edge.
   */
  driverStorePublicKey: string;
  driverStoreKeyId: string;
  licensingPublicKey: string;
  /** Base URL of the Python protocol-commissioning service; empty = no scanners. */
  commissioningUrl: string;
  /** Base URL of the on-box AI model service; empty = built-in planner only. */
  aiUrl: string;
  /** NATS server URL for the cross-process event bus; empty = in-process bus. */
  natsUrl: string;
  /** Redis URL for shared presence/ephemeral state; empty = in-process. */
  redisUrl: string;
  /** OTLP/HTTP traces endpoint (e.g. http://collector:4318/v1/traces); empty = tracing off. */
  otelEndpoint: string;
  /** MQTT broker URL for the native MQTT protocol driver; empty = driver not loaded. */
  mqttUrl: string;
  /** Modbus TCP host for the native Modbus driver; empty = driver not loaded. */
  modbusHost: string;
  /** Modbus TCP port (default 502). */
  modbusPort: number;
  /** KNXnet/IP gateway host (tunnelling) for the native KNX driver; empty = not loaded. */
  knxHost: string;
  /** KNXnet/IP port (default 3671). */
  knxPort: number;
  /** Enable the on-box Matter controller driver (opt-in; ships disabled). */
  matterEnabled: boolean;
  /** Filesystem path for the Matter controller's fabric/credential storage. */
  matterStoragePath: string;
  /** Zigbee coordinator serial port for the native Zigbee driver; empty = not loaded. */
  zigbeePort: string;
  /** zigbee-herdsman adapter type (zstack/deconz/ezsp). */
  zigbeeAdapter: string;
  /** DALI (IEC 62386) interface serial port for the native DALI driver; empty = not loaded. */
  daliPort: string;
  /** Enable the AVR IP-control driver (Denon/Marantz); receivers are added by IP at bind time. */
  avrEnabled: boolean;
  /** CoolMasterNet HVAC bridge host for the native CoolMaster driver; empty = not loaded. */
  coolMasterHost: string;
  /** SIP registrar/server for the door-station driver; empty = not loaded. */
  sipServer: string;
  /** Enable media/security drivers added by IP/account at bind time. */
  wiimEnabled: boolean;
  devialetEnabled: boolean;
  sonosEnabled: boolean;
  ajaxEnabled: boolean;
  shellyEnabled: boolean;
  airplayEnabled: boolean;
  /** Enable the Apple TV driver (mDNS discovery + pyatv-backed MRP control client). */
  appleTvEnabled: boolean;
  /** Base URL of the Python Apple TV bridge (pyatv); empty = discovery only, no control. */
  appleTvBridgeUrl: string;
  /** Public base URL of the hub API (e.g. https://home.example) used to build absolute
   * client-reachable media artwork URLs; empty = artwork URLs are omitted from state. */
  publicBaseUrl: string;
  /** Lutron bridge host (RA2/HWQS wired or Caséta Pro wireless) over LIP; empty = off. */
  lutronHost: string;
  lutronUsername: string;
  lutronPassword: string;
  tuyaEnabled: boolean;
  /** Public base URL of the hub's camera stream engine (HLS/WebRTC); empty = no transcode. */
  streamBaseUrl: string;
  /** Stream engine the hub runs: "go2rtc" | "mediamtx". */
  streamEngine: string;
  /** Stream engine admin API for dynamic source registration; empty = config-driven. */
  streamApiUrl: string;
  /** Cloud push-relay URL; empty = push disabled (WSS-only delivery). */
  pushRelayUrl: string;
  /** Bearer token the cloud push relay authenticates the hub with. */
  pushRelayToken: string;
  /** Cloud relay base URL for the remote-access tunnel; empty = no remote access. */
  relayUrl: string;
  /** Bearer token the hub presents to the relay's tunnel. */
  relayToken: string;
  /** Signed OTA channel manifest URL; empty = no update checks. */
  otaUrl: string;
  /** Embedded OTA signing public key (PEM) to verify release manifests. */
  otaPublicKey: string;
  /** Deployment environment; "production" enables fail-closed checks. */
  nodeEnv: string;
  /** Allowed CORS origins; empty = allow all in dev, deny all in production. */
  corsOrigins: string[];
  /** Global request rate limit (per IP, per minute). */
  rateMax: number;
  /** Stricter rate limit for /v1/auth/* (per IP, per minute). */
  authRateMax: number;
  logLevel: string;
}

/** The insecure development default — refused in production (fail-closed). */
export const DEV_TOKEN_SECRET = "dev-only-insecure-secret-change-me-change-me";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const backend = env.SUPREME_BACKEND === "ha" ? "ha" : "mock";
  return {
    host: env.SUPREME_HOST ?? "0.0.0.0",
    port: Number(env.SUPREME_PORT ?? 8080),
    tokenSecret: secret(env, "SUPREME_TOKEN_SECRET") ?? DEV_TOKEN_SECRET,
    backend,
    haUrl: env.SUPREME_HA_URL ?? "ws://127.0.0.1:8123/api/websocket",
    haToken: secret(env, "SUPREME_HA_TOKEN") ?? "",
    databaseUrl: secret(env, "DATABASE_URL") ?? "",
    hubVersion: env.SUPREME_HUB_VERSION ?? "0.2.0",
    driverStorePublicKey: secret(env, "SUPREME_DRIVER_STORE_PUBLIC_KEY") ?? "",
    driverStoreKeyId: env.SUPREME_DRIVER_STORE_KEY_ID ?? "supreme-store",
    licensingPublicKey: secret(env, "SUPREME_LICENSING_PUBLIC_KEY") ?? "",
    commissioningUrl: env.SUPREME_COMMISSIONING_URL ?? "",
    aiUrl: env.SUPREME_AI_URL ?? "",
    natsUrl: env.SUPREME_NATS_URL ?? "",
    redisUrl: env.SUPREME_REDIS_URL ?? "",
    otelEndpoint:
      env.SUPREME_OTEL_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "",
    mqttUrl: env.SUPREME_MQTT_URL ?? "",
    modbusHost: env.SUPREME_MODBUS_HOST ?? "",
    modbusPort: Number(env.SUPREME_MODBUS_PORT ?? 502),
    knxHost: env.SUPREME_KNX_HOST ?? "",
    knxPort: Number(env.SUPREME_KNX_PORT ?? 3671),
    matterEnabled: env.SUPREME_MATTER_ENABLED === "1" || env.SUPREME_MATTER_ENABLED === "true",
    matterStoragePath: env.SUPREME_MATTER_STORAGE_PATH ?? "",
    zigbeePort: env.SUPREME_ZIGBEE_PORT ?? "",
    zigbeeAdapter: env.SUPREME_ZIGBEE_ADAPTER ?? "zstack",
    daliPort: env.SUPREME_DALI_PORT ?? "",
    avrEnabled: env.SUPREME_AVR_ENABLED === "1" || env.SUPREME_AVR_ENABLED === "true",
    coolMasterHost: env.SUPREME_COOLMASTER_HOST ?? "",
    sipServer: env.SUPREME_SIP_SERVER ?? "",
    wiimEnabled: env.SUPREME_WIIM_ENABLED === "1" || env.SUPREME_WIIM_ENABLED === "true",
    devialetEnabled: env.SUPREME_DEVIALET_ENABLED === "1" || env.SUPREME_DEVIALET_ENABLED === "true",
    sonosEnabled: env.SUPREME_SONOS_ENABLED === "1" || env.SUPREME_SONOS_ENABLED === "true",
    ajaxEnabled: env.SUPREME_AJAX_ENABLED === "1" || env.SUPREME_AJAX_ENABLED === "true",
    shellyEnabled: env.SUPREME_SHELLY_ENABLED === "1" || env.SUPREME_SHELLY_ENABLED === "true",
    airplayEnabled: env.SUPREME_AIRPLAY_ENABLED === "1" || env.SUPREME_AIRPLAY_ENABLED === "true",
    appleTvEnabled: env.SUPREME_APPLETV_ENABLED === "1" || env.SUPREME_APPLETV_ENABLED === "true",
    appleTvBridgeUrl: env.SUPREME_APPLETV_URL ?? "",
    publicBaseUrl: (env.SUPREME_PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
    lutronHost: env.SUPREME_LUTRON_HOST ?? "",
    lutronUsername: env.SUPREME_LUTRON_USERNAME ?? "lutron",
    lutronPassword: secret(env, "SUPREME_LUTRON_PASSWORD") ?? "integration",
    tuyaEnabled: env.SUPREME_TUYA_ENABLED === "1" || env.SUPREME_TUYA_ENABLED === "true",
    streamBaseUrl: env.SUPREME_STREAM_BASE_URL ?? "",
    streamEngine: env.SUPREME_STREAM_ENGINE ?? "go2rtc",
    streamApiUrl: env.SUPREME_STREAM_API_URL ?? "",
    pushRelayUrl: secret(env, "SUPREME_PUSH_RELAY_URL") ?? "",
    pushRelayToken: secret(env, "SUPREME_PUSH_RELAY_TOKEN") ?? "",
    relayUrl: env.SUPREME_RELAY_URL ?? "",
    relayToken: secret(env, "SUPREME_RELAY_TOKEN") ?? "",
    otaUrl: env.SUPREME_OTA_URL ?? "",
    otaPublicKey: secret(env, "SUPREME_OTA_PUBLIC_KEY") ?? "",
    nodeEnv: env.NODE_ENV ?? "development",
    corsOrigins: (env.SUPREME_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    rateMax: Number(env.SUPREME_RATE_MAX ?? 1000),
    authRateMax: Number(env.SUPREME_AUTH_RATE_MAX ?? 50),
    logLevel: env.SUPREME_LOG_LEVEL ?? "info",
  };
}

/**
 * Fail-closed validation for production boots. Refuses to start with insecure
 * defaults so a misconfigured hub never ships weak auth. Called at the boot edge.
 */
export function assertSecureConfig(config: GatewayConfig): void {
  if (config.nodeEnv !== "production") return;
  const problems: string[] = [];
  if (config.tokenSecret === DEV_TOKEN_SECRET) problems.push("SUPREME_TOKEN_SECRET is the insecure dev default");
  if (config.tokenSecret.length < 32) problems.push("SUPREME_TOKEN_SECRET must be >= 32 chars");
  if (config.corsOrigins.length === 0) problems.push("SUPREME_CORS_ORIGINS must be set in production");
  if (problems.length > 0) {
    throw new Error(`refusing to boot (production hardening): ${problems.join("; ")}`);
  }
}
