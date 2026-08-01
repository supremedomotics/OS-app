import type { UdpTransportFactory } from "@supreme/lan";
import { CasambiLocalRestClient } from "./rest-client.js";
import { CasambiUdpEngine } from "./udp-engine.js";
import type { CasambiWireFormat } from "./udp-codec.js";

/**
 * Casambi Local Gateway — Local Transport (§ Casambi Driver Refactor — PR-2, Local Gateway
 * Foundation). Composes the REST Client (the one documented write endpoint) and UDP Engine (the
 * fully-documented realtime command/notification protocol) that together are the Local
 * counterpart of {@link import("../cloud-transport.js").HttpCasambiTransport}. Both children are
 * real implementations now — this class wires them together behind one settings object, exactly
 * the seam the Connection Manager hands to the driver.
 */
export interface CasambiLocalGatewayConfig {
  gatewayIp: string;
  restPort: number;
  udpPort: number;
  gatewayName?: string;
  /** § Casambi Local Gateway Auth — the Lithernet Gateway's own web-server login
   * (`Lithernet_General_Settings_Network.pdf` p.64), required by every Local REST request. This
   * is a distinct, independently-stored credential pair, never the Casambi Cloud
   * `email`/`password`/`apiKey`. Optional because a gateway may have no login configured. */
  gatewayUsername?: string;
  gatewayPassword?: string;
  /** This bridge's own Net ID (0-254) for outgoing UDP commands. Default 0. */
  netId?: number;
  /** UDP wire text format — must match the gateway's own "DEC or HEX" setting. Default
   * `hex-dot` (the gateway's own factory default). */
  dataFormat?: CasambiWireFormat;
  /** Wizard "Auto Discover" preference — not yet implemented (see TODO.md: no REST device-
   * listing endpoint is documented, so "auto discovery" beyond UDP NotifyControlValues
   * subscription has no protocol to drive it). */
  autoDiscover?: boolean;
  /** § LAN Transport Phase 2 — factory for the generic `UdpTransport` (`@supreme/lan`) the UDP
   * engine sends/receives through. REQUIRED: this driver no longer owns a raw socket or has any
   * protocol-specific socket factory of its own — real `NatsUdpTransportClient` (a real
   * `supreme-lan` service) or `LocalDirectUdpTransport` (same-process real `dgram`, no NATS) in
   * production, a fake `UdpTransport` in tests. See
   * `docs/architecture/adr/0022-supreme-lan-transport-service.md`. */
  udpTransportFactory: UdpTransportFactory;
}

export class CasambiLocalTransport {
  readonly rest: CasambiLocalRestClient;
  readonly udp: CasambiUdpEngine;
  readonly config: CasambiLocalGatewayConfig;

  constructor(config: CasambiLocalGatewayConfig) {
    this.config = config;
    this.rest = new CasambiLocalRestClient({
      gatewayIp: config.gatewayIp,
      restPort: config.restPort,
      gatewayName: config.gatewayName,
      gatewayUsername: config.gatewayUsername,
      gatewayPassword: config.gatewayPassword,
    });
    this.udp = new CasambiUdpEngine({
      gatewayIp: config.gatewayIp,
      udpPort: config.udpPort,
      netId: config.netId ?? 0,
      format: config.dataFormat ?? "hex-dot",
      udpTransportFactory: config.udpTransportFactory,
    });
  }
}
