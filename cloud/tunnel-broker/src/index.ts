/**
 * @supreme/tunnel-broker — the zero-trust, cert-authenticated, hub-initiated remote-access
 * broker (ADR 0009). Replaces the Phase-1 shared-token relay's tunnel. See broker.ts/server.ts.
 */
export {
  TunnelBroker,
  type BrokerSocket,
  type HubHandshake,
  type HandshakeResult,
  type TunnelBrokerOptions,
  type TunnelRequest,
  type TunnelResponse,
} from "./broker.js";
export { buildTunnelBrokerServer, type TunnelBrokerServerOptions } from "./server.js";
