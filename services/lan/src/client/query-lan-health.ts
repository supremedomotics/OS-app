import type { IEventBus } from "@supreme/messaging";
import { requestReply } from "../shared/rpc.js";
import { lanSubjects, type LanForensicsRequest, type LanForensicsResponse, type LanHealthRequest, type LanHealthResponse } from "../shared/wire-types.js";

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

/**
 * § Runtime Data Path Verification — the deep forensics query. Same request/reply mechanics as
 * {@link queryLanHealth}, against `supreme.lan.forensics`. Deliberately a SEPARATE call rather
 * than more fields on health: this one reads `/proc` and walks every session on the service side,
 * so it is issued when someone is actually diagnosing a receive-path failure, not on every poll.
 *
 * Throws rather than returning a fabricated snapshot when nothing answers — an unanswered
 * forensics request and a service reporting "no traffic" must never look alike, since telling them
 * apart is the entire purpose of this diagnostic.
 */
export async function queryLanForensics(bus: IEventBus, timeoutMs = 5_000): Promise<LanForensicsResponse> {
  return requestReply<LanForensicsRequest, LanForensicsResponse>(bus, lanSubjects.forensics, {}, { timeoutMs });
}
