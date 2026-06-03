/**
 * @supreme/gateway — the Supreme API Gateway / BFF (§6). The only client-facing
 * surface; speaks pure Supreme contracts, talks downward only to the SIL facade.
 */
export { buildServer, authenticate } from "./server.js";
export { AppContext } from "./context.js";
export { loadConfig, type GatewayConfig } from "./config.js";
export { HomeState, seedDemoHome } from "./home-state.js";
