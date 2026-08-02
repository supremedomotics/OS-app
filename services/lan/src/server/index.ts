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
export {
  replayableDgramSocket,
  fakeDgramSocket,
  makeCapture,
  capturedDatagramAscii,
  capturedDatagramBuffer,
  type CapturedDatagram,
  type PacketCapture,
  type ReplayHandle,
  type LiveCaptureHandle,
} from "./replay-dgram-socket.js";
export { saveCaptureJson, loadCaptureJson, exportPcap } from "./capture-io.js";
export { diagnoseRouting, ipInCidr, type RoutingDiagnosis, type RoutingVerdict } from "./routing-diagnosis.js";
export {
  resolveDeployment,
  DEPLOYMENTS,
  type LanDeployment,
  type LanDeploymentId,
  type LanAccess,
} from "./deployment.js";
export {
  collectNetworkForensics,
  findKernelSocket,
  parseKernelHexAddress,
  parseProcNetRoute,
  parseProcNetUdp,
  type NetworkForensics,
  type SocketForensics,
  type ForensicInterface,
  type ForensicRoute,
  type ForensicUdpSocket,
} from "./network-forensics.js";
export { UdpProbe, defaultProbeSocket, type UdpProbeOptions, type UdpProbeSnapshot, type ProbeDatagram } from "./udp-probe.js";
