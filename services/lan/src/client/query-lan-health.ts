import type { IEventBus } from "@supreme/messaging";
import { requestReply } from "../shared/rpc.js";
import { lanSubjects, type LanHealthRequest, type LanHealthResponse } from "../shared/wire-types.js";

/**
 * § LAN Transport Phase 2 — Transport Monitor's service-wide view. Queries the running
 * `supreme-lan` service's own {@link LanHealthResponse} (interfaces, configured network mode,
 * NATS connectivity, every open session's real counters) over the SAME `supreme.lan.health`
 * request/reply subject `services/lan/src/server/main.ts` already answers — no new wire protocol,
 * just a client-side caller for the one Phase 1 built but nothing yet called from the Gateway
 * side. Throws (never returns a fabricated snapshot) if no `supreme-lan` instance replies within
 * `timeoutMs` — callers decide how to surface that (e.g. the Transport Monitor route reports
 * `lan: null, lanQueryError: <message>` rather than pretending the service answered).
 */
export async function queryLanHealth(bus: IEventBus, timeoutMs = 2_000): Promise<LanHealthResponse> {
  return requestReply<LanHealthRequest, LanHealthResponse>(bus, lanSubjects.health, {}, { timeoutMs });
}
