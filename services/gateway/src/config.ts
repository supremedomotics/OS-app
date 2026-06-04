/**
 * Gateway configuration. All values come from the hub environment; sensible
 * local defaults keep the dev/test loop frictionless. Secrets must be provided
 * in production (the hub's sealed store injects them) — see infra/hub-compose.
 */
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
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const backend = env.SUPREME_BACKEND === "ha" ? "ha" : "mock";
  return {
    host: env.SUPREME_HOST ?? "0.0.0.0",
    port: Number(env.SUPREME_PORT ?? 8080),
    tokenSecret:
      env.SUPREME_TOKEN_SECRET ?? "dev-only-insecure-secret-change-me-change-me",
    backend,
    haUrl: env.SUPREME_HA_URL ?? "ws://127.0.0.1:8123/api/websocket",
    haToken: env.SUPREME_HA_TOKEN ?? "",
    databaseUrl: env.DATABASE_URL ?? "",
    hubVersion: env.SUPREME_HUB_VERSION ?? "0.2.0",
    driverStorePublicKey: env.SUPREME_DRIVER_STORE_PUBLIC_KEY ?? "",
    driverStoreKeyId: env.SUPREME_DRIVER_STORE_KEY_ID ?? "supreme-store",
    licensingPublicKey: env.SUPREME_LICENSING_PUBLIC_KEY ?? "",
    commissioningUrl: env.SUPREME_COMMISSIONING_URL ?? "",
    logLevel: env.SUPREME_LOG_LEVEL ?? "info",
  };
}
