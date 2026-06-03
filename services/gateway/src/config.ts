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
    logLevel: env.SUPREME_LOG_LEVEL ?? "info",
  };
}
