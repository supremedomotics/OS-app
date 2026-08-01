import { createEventBus } from "@supreme/messaging";
import { handleRequests } from "../shared/rpc.js";
import { lanSubjects, type LanHealthRequest, type LanHealthResponse } from "../shared/wire-types.js";
import { UdpTransportServer } from "./udp-transport-server.js";
import { buildDiagnosticsSnapshot } from "./health.js";

/**
 * `supreme-lan` service entrypoint (§ Production Architecture Refactor — SupremeOS LAN Transport
 * Service). Deliberately tiny: no HTTP server, no database, no auth — it connects to the SAME
 * NATS instance the Gateway already uses (`@supreme/messaging`'s `createEventBus`, the identical
 * factory `services/gateway/src/bootstrap.ts` calls) and starts the UDP transport server. Runnable
 * three ways, all producing the identical behavior: `docker compose up lan` (bridge, degraded —
 * no real LAN broadcast), the same compose layered with `docker-compose.lan-host.yml` (host
 * networking, real LAN access, Linux only), or as a plain native process (`node dist/server/main.js`)
 * on a machine where Docker host networking is a no-op (Windows/Mac Docker Desktop) — see
 * `docs/architecture/Supreme-LAN-Transport-Architecture.md`.
 */

function isNetworkMode(v: string | undefined): v is "bridge" | "host" | "macvlan" {
  return v === "bridge" || v === "host" || v === "macvlan";
}

async function main(): Promise<void> {
  const natsUrl = process.env.SUPREME_LAN_NATS_URL ?? process.env.SUPREME_NATS_URL ?? "";
  const networkModeEnv = process.env.SUPREME_LAN_NETWORK_MODE;
  const networkMode = isNetworkMode(networkModeEnv) ? networkModeEnv : "bridge";
  const startedAt = Date.now();

  const bus = await createEventBus({ natsUrl });
  const server = new UdpTransportServer(bus);
  await server.start();

  const healthSub = await handleRequests<LanHealthRequest, LanHealthResponse>(
    bus,
    lanSubjects.health,
    async () =>
      buildDiagnosticsSnapshot({
        networkMode,
        natsConnected: natsUrl.length > 0,
        startedAt,
        sessions: server.sessionDiagnostics(),
      }),
    () =>
      buildDiagnosticsSnapshot({
        networkMode,
        natsConnected: natsUrl.length > 0,
        startedAt,
        sessions: server.sessionDiagnostics(),
      }),
  );

  // eslint-disable-next-line no-console
  console.log(`[supreme-lan] listening on NATS ${natsUrl || "(in-process — no NATS URL configured)"}, networkMode=${networkMode}`);

  const shutdown = async (): Promise<void> => {
    healthSub.unsubscribe();
    await server.stop();
    await bus.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

void main();
