/**
 * @supreme/relay — the optional Supreme Cloud relay (§8, §13). Push fan-out to
 * FCM/APNs/WebPush + an outbound-only remote-access tunnel. Nothing in-home depends on
 * it; the hub is fully functional offline.
 */
export { buildRelayServer, type RelayServerOptions } from "./relay-server.js";
export {
  PushDispatcher,
  FcmProvider,
  WebPushProvider,
  type IRelayPushProvider,
  type RelayPushPayload,
  type FcmProviderOptions,
  type WebPushProviderOptions,
} from "./push-dispatcher.js";
export {
  TunnelRegistry,
  type RelaySocket,
  type TunnelRequest,
  type TunnelResponse,
} from "./tunnel.js";
