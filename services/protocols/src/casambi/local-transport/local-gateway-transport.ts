import { CasambiLocalRestClient } from "./rest-client.js";
import { CasambiUdpEngine, type CasambiUdpSocketFactory } from "./udp-engine.js";
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
  /** This bridge's own Net ID (0-254) for outgoing UDP commands. Default 0. */
  netId?: number;
  /** UDP wire text format — must match the gateway's own "DEC or HEX" setting. Default
   * `hex-dot` (the gateway's own factory default). */
  dataFormat?: CasambiWireFormat;
  /** Wizard "Auto Discover" preference — not yet implemented (see TODO.md: no REST device-
   * listing endpoint is documented, so "auto discovery" beyond UDP NotifyControlValues
   * subscription has no protocol to drive it). */
  autoDiscover?: boolean;
  /** Injectable UDP socket (tests pass a fake), matching `cloud-transport.ts`'s injectable
   * `socketFactory`/`fetchImpl` testing pattern. Never set in production. */
  udpSocketFactory?: CasambiUdpSocketFactory;
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
    });
    this.udp = new CasambiUdpEngine({
      gatewayIp: config.gatewayIp,
      udpPort: config.udpPort,
      netId: config.netId ?? 0,
      format: config.dataFormat ?? "hex-dot",
      socketFactory: config.udpSocketFactory,
    });
  }
}
