import { CasambiLocalRestClient } from "./rest-client.js";
import { CasambiUdpEngine } from "./udp-engine.js";

/**
 * Casambi Local Gateway — Local Transport (§ PR-2/PR-3). Composes the REST Client (persistent
 * model + control writes) and UDP Engine (realtime feedback) that together are the Local
 * counterpart of {@link import("../cloud-transport.js").HttpCasambiTransport}. Neither child is
 * implemented yet (see their own doc comments) — this class only wires the two together behind
 * one settings object, exactly the seam the Connection Manager hands to the driver.
 */
export interface CasambiLocalGatewayConfig {
  gatewayIp: string;
  restPort: number;
  udpPort: number;
  gatewayName?: string;
  /** Wizard "Auto Discover" preference — not yet implemented (see PR-2). */
  autoDiscover?: boolean;
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
    this.udp = new CasambiUdpEngine({ gatewayIp: config.gatewayIp, udpPort: config.udpPort });
  }
}
