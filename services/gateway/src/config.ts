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
  backend: "mock" | "ha" | "native";
  haUrl: string;
  /** HA long-lived token. Optional: when empty and backend=ha, the hub provisions HA
   * headlessly on first boot and stores the generated token in the secrets manager. */
  haToken: string;
  /** HA HTTP base (for onboarding); derived from haUrl when not set. */
  haHttpUrl: string;
  /** Hidden internal HA account the gateway provisions + uses. Never shown in any UI. */
  haAdminUser: string;
  haAdminPassword: string;
  /** Directory for runtime-generated secrets (the provisioned HA token); empty = in-memory. */
  secretsDir: string;
  /** Developer Mode (§dev): when true, HA may be published on 8123 for debugging. Off by default. */
  devMode: boolean;
  /**
   * When true, the runtime Developer-Mode toggle is LOCKED (customer/OEM builds set this). Default
   * false so an owner running the hub can enable Developer Mode from the UI. Note: the hub image runs
   * with NODE_ENV=production for perf/logging, which is NOT the same as "no dev mode allowed" — hence
   * a dedicated lock rather than keying off NODE_ENV.
   */
  devModeLocked: boolean;
  /** Setup Wizard mode: on production first boot, wait for the wizard to create the admin
   * instead of auto-seeding a demo owner. Off by default (dev/tests keep the demo home). */
  setupWizard: boolean;
  /** Friendly system/home name used during onboarding + shown in the UI. */
  systemName: string;
  /** IANA time zone + optional coordinates seeded into HA's core config. */
  timeZone: string;
  latitude: number | null;
  longitude: number | null;
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
  /** Optional cloud Matter service base URL (fabric/multi-admin sync); empty = local-only. */
  matterCloudUrl: string;
  /** Per-hub API key for the cloud Matter service (maps to this home). */
  matterCloudApiKey: string;
  /** Informational home id passed to the Matter fabric manager (cloud derives home from the key). */
  homeId: string;
  /** Optional cloud Voice service base URL for proactive state reporting; empty = off. */
  voiceCloudUrl: string;
  /** Per-hub key the cloud Voice service maps to this home. */
  voiceHubKey: string;
  /** Enable the local HomeKit (HAP) bridge for Apple Home / Siri (opt-in; needs the HAP transport). */
  homekitEnabled: boolean;
  /** Zigbee coordinator serial port for the native Zigbee driver; empty = not loaded. */
  zigbeePort: string;
  /** zigbee-herdsman adapter type (zstack/deconz/ezsp). */
  zigbeeAdapter: string;
  /** DALI (IEC 62386) interface serial port for the native DALI driver; empty = not loaded. */
  daliPort: string;
  /** Enable the AVR IP-control driver (Denon/Marantz); receivers are added by IP at bind time. */
  avrEnabled: boolean;
  /** § AVR Diagnostic Mode — off by default. When true, the AVR driver traces the complete
   * lifecycle of every real receiver event under a correlation ID, for export/analysis (see
   * `docs/architecture/AVR-Diagnostic-Mode.md`). Adapted from the requested `AVR_DIAGNOSTICS`
   * name to match this file's `SUPREME_`-prefixed convention. */
  avrDiagnostics: boolean;
  /** Enable the HEOS CLI driver (Denon/Marantz whole-home streaming); the HEOS network is added
   * by any one player's IP at bind time — one connection then reaches every player by pid. */
  heosEnabled: boolean;
  /** Enable the Yamaha Extended Control driver (YXC/MusicCast); units are added by IP at bind time. */
  yamahaEnabled: boolean;
  /** CoolMasterNet/CoolLinux HVAC gateway host for the native CoolMaster driver; empty =
   * not loaded. See docs/coolmaster/README.md for the full config surface. */
  coolMasterHost: string;
  /** "auto" (prefer REST v2, fall back to ASCII_IF) | "ascii" | "rest". */
  coolMasterProtocol: string;
  coolMasterAsciiPort: number;
  coolMasterRestPort: number;
  coolMasterPollMs: number;
  coolMasterSlowPollMs: number;
  coolMasterDiscoveryIntervalMs: number;
  coolMasterTimeoutMs: number;
  coolMasterRetryCount: number;
  coolMasterDebug: boolean;
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
  /** Casambi Cloud credentials (BLE-mesh luminaires). All empty = off. Key/password come from the
   * sealed secrets store, never plaintext env — see the *_FILE convention above. */
  casambiApiKey: string;
  casambiEmail: string;
  casambiPassword: string;
  casambiNetworkId: string;
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
  /** Cloud Hub Registry base URL for zero-touch enrollment; empty = no cloud enrollment. */
  hubRegistryUrl: string;
  /** This hub's hardware model, reported at enrollment. */
  hubModel: string;
  /** Signed OTA channel manifest URL; empty = no update checks. */
  otaUrl: string;
  /** Embedded OTA signing public key (PEM) to verify release manifests. */
  otaPublicKey: string;
  /** WebAuthn/passkey Relying-Party id (the hub's domain) + expected origin; unset → localhost dev. */
  webAuthnRpId?: string;
  webAuthnOrigin?: string;
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
  // ADR-0023 § Native Backend: "native" (no Home Assistant leg at all) is the
  // production default. "ha" additionally registers Home Assistant as one more
  // provider driver. "mock" exists ONLY for tests/CI — never select it via a real
  // deployment's env, since it's the one path that doesn't talk to a real backend.
  const backend = env.SUPREME_BACKEND === "ha" ? "ha" : env.SUPREME_BACKEND === "mock" ? "mock" : "native";
  return {
    host: env.SUPREME_HOST ?? "0.0.0.0",
    port: Number(env.SUPREME_PORT ?? 8080),
    tokenSecret: secret(env, "SUPREME_TOKEN_SECRET") ?? DEV_TOKEN_SECRET,
    backend,
    haUrl: env.SUPREME_HA_URL ?? "ws://127.0.0.1:8123/api/websocket",
    haToken: secret(env, "SUPREME_HA_TOKEN") ?? "",
    haHttpUrl: env.SUPREME_HA_HTTP_URL ?? "",
    haAdminUser: env.SUPREME_HA_ADMIN_USER ?? "admin",
    haAdminPassword: secret(env, "SUPREME_HA_ADMIN_PASSWORD") ?? "admin@supremeos",
    secretsDir: env.SUPREME_SECRETS_DIR ?? "",
    devMode: env.SUPREME_DEV_MODE === "1" || env.SUPREME_DEV_MODE === "true",
    devModeLocked: env.SUPREME_DEV_MODE_LOCKED === "1" || env.SUPREME_DEV_MODE_LOCKED === "true",
    setupWizard: env.SUPREME_SETUP_WIZARD === "1" || env.SUPREME_SETUP_WIZARD === "true",
    systemName: env.SUPREME_SYSTEM_NAME ?? "Supreme Residence",
    timeZone: env.SUPREME_TZ ?? "UTC",
    latitude: env.SUPREME_LATITUDE ? Number(env.SUPREME_LATITUDE) : null,
    longitude: env.SUPREME_LONGITUDE ? Number(env.SUPREME_LONGITUDE) : null,
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
    matterCloudUrl: env.SUPREME_MATTER_CLOUD_URL ?? "",
    matterCloudApiKey: env.SUPREME_MATTER_CLOUD_API_KEY ?? "",
    homeId: env.SUPREME_HOME_ID ?? "primary",
    voiceCloudUrl: env.SUPREME_VOICE_CLOUD_URL ?? "",
    voiceHubKey: secret(env, "VOICE_HUB_KEY") ?? "",
    homekitEnabled: env.SUPREME_HOMEKIT_ENABLED === "1" || env.SUPREME_HOMEKIT_ENABLED === "true",
    zigbeePort: env.SUPREME_ZIGBEE_PORT ?? "",
    zigbeeAdapter: env.SUPREME_ZIGBEE_ADAPTER ?? "zstack",
    daliPort: env.SUPREME_DALI_PORT ?? "",
    avrEnabled: env.SUPREME_AVR_ENABLED === "1" || env.SUPREME_AVR_ENABLED === "true",
    avrDiagnostics: env.SUPREME_AVR_DIAGNOSTICS === "1" || env.SUPREME_AVR_DIAGNOSTICS === "true",
    heosEnabled: env.SUPREME_HEOS_ENABLED === "1" || env.SUPREME_HEOS_ENABLED === "true",
    yamahaEnabled: env.SUPREME_YAMAHA_ENABLED === "1" || env.SUPREME_YAMAHA_ENABLED === "true",
    coolMasterHost: env.SUPREME_COOLMASTER_HOST ?? "",
    coolMasterProtocol: env.SUPREME_COOLMASTER_PROTOCOL ?? "auto",
    coolMasterAsciiPort: Number(env.SUPREME_COOLMASTER_ASCII_PORT ?? 10102),
    coolMasterRestPort: Number(env.SUPREME_COOLMASTER_REST_PORT ?? 10103),
    coolMasterPollMs: Number(env.SUPREME_COOLMASTER_POLL_MS ?? 10_000),
    coolMasterSlowPollMs: Number(env.SUPREME_COOLMASTER_SLOW_POLL_MS ?? 300_000),
    coolMasterDiscoveryIntervalMs: Number(env.SUPREME_COOLMASTER_DISCOVERY_INTERVAL_MS ?? 1_800_000),
    coolMasterTimeoutMs: Number(env.SUPREME_COOLMASTER_TIMEOUT_MS ?? 5_000),
    coolMasterRetryCount: Number(env.SUPREME_COOLMASTER_RETRY_COUNT ?? 3),
    coolMasterDebug: env.SUPREME_COOLMASTER_DEBUG === "1" || env.SUPREME_COOLMASTER_DEBUG === "true",
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
    casambiApiKey: secret(env, "SUPREME_CASAMBI_API_KEY") ?? "",
    casambiEmail: env.SUPREME_CASAMBI_EMAIL ?? "",
    casambiPassword: secret(env, "SUPREME_CASAMBI_PASSWORD") ?? "",
    casambiNetworkId: env.SUPREME_CASAMBI_NETWORK_ID ?? "",
    streamBaseUrl: env.SUPREME_STREAM_BASE_URL ?? "",
    streamEngine: env.SUPREME_STREAM_ENGINE ?? "go2rtc",
    streamApiUrl: env.SUPREME_STREAM_API_URL ?? "",
    pushRelayUrl: secret(env, "SUPREME_PUSH_RELAY_URL") ?? "",
    pushRelayToken: secret(env, "SUPREME_PUSH_RELAY_TOKEN") ?? "",
    relayUrl: env.SUPREME_RELAY_URL ?? "",
    relayToken: secret(env, "SUPREME_RELAY_TOKEN") ?? "",
    hubRegistryUrl: env.SUPREME_HUB_REGISTRY_URL ?? "",
    hubModel: env.SUPREME_HUB_MODEL ?? "Supreme Hub",
    otaUrl: env.SUPREME_OTA_URL ?? "",
    webAuthnRpId: env.SUPREME_WEBAUTHN_RP_ID,
    webAuthnOrigin: env.SUPREME_WEBAUTHN_ORIGIN,
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
  // § Native Backend Implementation — the offline mock vertical slice must never run a
  // real production hub (§ Never fabricate data or capabilities): a mock-backed device
  // silently "succeeds" against in-memory state that was never real. Use the default
  // ("native") or "ha" instead.
  if (config.backend === "mock") problems.push('SUPREME_BACKEND=mock is not permitted in production — use "native" (the default) or "ha"');
  if (problems.length > 0) {
    throw new Error(`refusing to boot (production hardening): ${problems.join("; ")}`);
  }
}
