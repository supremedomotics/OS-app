/**
 * `@supreme/lan/server` — the real, socket-owning half of the LAN Transport Service. Only the
 * actual deployable process (`services/lan/src/server/main.ts`, run via `node dist/server/main.js`
 * / `pnpm --filter @supreme/lan start`) and this package's own tests should ever import from
 * here. Kept as a separate export path from the default `@supreme/lan` barrel (`../index.ts`) so
 * a driver/adapter can never accidentally construct a `UdpTransportServer` or a real
 * `DgramUdpSession` directly — that would defeat the whole point of moving raw socket ownership
 * out of the Gateway process.
 */
export { UdpTransportServer } from "./udp-transport-server.js";
export { DgramUdpSession, defaultDgramSocket, type DgramSocketLike, type DgramSocketFactory } from "./dgram-udp-session.js";
export { buildDiagnosticsSnapshot, type LanHealthInputs } from "./health.js";
