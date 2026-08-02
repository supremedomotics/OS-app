import { createEventBus } from "@supreme/messaging";
import { handleRequests } from "../shared/rpc.js";
import { lanSubjects, type LanHealthRequest, type LanHealthResponse } from "../shared/wire-types.js";
import { UdpTransportServer } from "./udp-transport-server.js";
import { buildDiagnosticsSnapshot } from "./health.js";
import { resolveDeployment } from "./deployment.js";

/**
 * `supreme-lan` service entrypoint (§ Production Architecture Refactor — SupremeOS LAN Transport
 * Service). Deliberately tiny: no HTTP server, no database, no auth — it connects to the SAME
 * NATS instance the Gateway already uses (`@supreme/messaging`'s `createEventBus`, the identical
 * factory `services/gateway/src/bootstrap.ts` calls) and starts the UDP transport server.
 *
 * § Production Architecture Direction — this entrypoint is deployment-agnostic BY CONSTRUCTION. It
 * reads a deployment identity from the environment and otherwise behaves identically whether it is
 * started by systemd on a SupremeOS image (the shipping target), by Docker Compose (development
 * and CI), or by hand as a plain `node dist/server/main.js`. Nothing below branches on the runtime;
 * see `deployment.ts`, the only module that knows deployment-specific vocabulary, and
 * `infra/systemd/supreme-lan.service` for the production unit.
 */

async function main(): Promise<void> {
  const natsUrl = process.env.SUPREME_LAN_NATS_URL ?? process.env.SUPREME_NATS_URL ?? "";
  const deployment = resolveDeployment();
  const startedAt = Date.now();

  const bus = await createEventBus({ natsUrl });
  const server = new UdpTransportServer(bus, undefined, deployment);
  await server.start();

  const healthSub = await handleRequests<LanHealthRequest, LanHealthResponse>(
    bus,
    lanSubjects.health,
    async () =>
      buildDiagnosticsSnapshot({
        deployment,
        natsConnected: natsUrl.length > 0,
        startedAt,
        sessions: server.sessionDiagnostics(),
      }),
    () =>
      buildDiagnosticsSnapshot({
        deployment,
        natsConnected: natsUrl.length > 0,
        startedAt,
        sessions: server.sessionDiagnostics(),
      }),
  );

  // eslint-disable-next-line no-console
  console.log(`[supreme-lan] listening on NATS ${natsUrl || "(in-process — no NATS URL configured)"}, deployment=${deployment.id} (${deployment.label}), lanAccess=${deployment.lanAccess}`);

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
