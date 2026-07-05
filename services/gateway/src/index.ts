/**
 * @supreme/gateway — the Supreme API Gateway / BFF (§6). The only client-facing
 * surface; speaks pure Supreme contracts, talks downward only to the SIL facade
 * and the Supreme domain services.
 */
export { buildServer } from "./server.js";
export { authenticate } from "./auth.js";
export { AppContext } from "./context.js";
export { createHubContext } from "./bootstrap.js";
export { loadConfig, type GatewayConfig } from "./config.js";
