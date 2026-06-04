import {
  EntityRegistryMirror,
  HaAdapter,
  HaWsTransport,
  SupremeIntegrationLayer,
} from "@supreme/integration-layer";
import type { GatewayConfig } from "./config.js";
import { AppContext } from "./context.js";

/**
 * Hub boot edge. This is where the concrete, HA-specific WebSocket transport is
 * assembled and injected into the SIL — the only place in the codebase that wires
 * the loopback HA URL + long-lived token (both held inside the SIL). Everything
 * above receives a ready {@link AppContext} and never learns a backend exists.
 *
 * With `SUPREME_BACKEND=mock`, the SIL uses the in-memory adapter and no HA wiring
 * happens, which is the standalone vertical slice used in dev and tests.
 */
export async function createHubContext(config: GatewayConfig): Promise<AppContext> {
  if (config.backend !== "ha") {
    return AppContext.create(config);
  }
  if (!config.haToken) {
    throw new Error("SUPREME_BACKEND=ha requires SUPREME_HA_TOKEN");
  }

  // The registry must be shared between the SIL facade (which records Supreme →
  // backend mappings) and the HaAdapter (which resolves them when commanding).
  const registry = new EntityRegistryMirror();
  const transport = new HaWsTransport({ url: config.haUrl, token: config.haToken });
  const adapter = new HaAdapter({ transport, registry });
  const sil = new SupremeIntegrationLayer({ adapter, registry });
  return AppContext.create(config, { sil });
}
