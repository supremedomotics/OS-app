/**
 * `@supreme/lan` — the Gateway-side (client) half of the LAN Transport Service. Import this from
 * `@supreme/protocols` (or any future consumer) to get real LAN transport backed by the running
 * `supreme-lan` service. Server internals (`./server/*`) are intentionally NOT re-exported here —
 * a driver/adapter has no business constructing a `DgramUdpSession` or `UdpTransportServer`
 * directly; that would defeat the whole point of moving raw socket ownership out of the Gateway
 * process. The server is a separate deployable entrypoint (`@supreme/lan/server`, i.e.
 * `services/lan/src/server/main.ts`).
 */
export type { UdpBindOptions, UdpTransport, UdpTransportFactory } from "./transport.js";
export { NatsUdpTransportClient } from "./client/nats-udp-transport-client.js";
export { LocalDirectUdpTransport } from "./client/local-direct-udp-transport.js";
export { queryLanHealth, queryLanForensics } from "./client/query-lan-health.js";
export {
  lanSubjects,
  type LanSessionId,
  type LanUdpBindOptions,
  type LanBindRequest,
  type LanBindResponse,
  type LanSendRequest,
  type LanSendResponse,
  type LanCloseRequest,
  type LanCloseResponse,
  type LanJoinMulticastRequest,
  type LanJoinMulticastResponse,
  type LanRxEvent,
  type LanErrorEvent,
  type LanListeningEvent,
  type LanClosedEvent,
  type LanSessionDiagnostics,
  type LanDiagnosticsSnapshot,
  type LanHealthRequest,
  type LanHealthResponse,
  type LanForensicsRequest,
  type LanForensicsResponse,
} from "./shared/wire-types.js";
export { requestReply, handleRequests, type RequestPayload } from "./shared/rpc.js";
