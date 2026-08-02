import { createEventBus } from "@supreme/messaging";
import { handleRequests } from "../shared/rpc.js";
import { lanSubjects, type LanForensicsRequest, type LanForensicsResponse, type LanHealthRequest, type LanHealthResponse } from "../shared/wire-types.js";
import { UdpTransportServer } from "./udp-transport-server.js";
import { buildDiagnosticsSnapshot } from "./health.js";
import { resolveDeployment } from "./deployment.js";
import { collectNetworkForensics } from "./network-forensics.js";
import { UdpProbe } from "./udp-probe.js";

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

  // § Runtime Data Path Verification — the independent listener. Opt-in via SUPREME_LAN_PROBE_PORT
  // because it binds a real port: enabling it by default would silently claim a port on every
  // deployment. When it is off, forensics reports `probe: null` plus the reason, so "no probe was
  // running" is never mistaken for "a probe ran and saw nothing".
  const probePort = Number(process.env.SUPREME_LAN_PROBE_PORT ?? "");
  let probe: UdpProbe | null = null;
  let probeDisabledReason: string | null = "SUPREME_LAN_PROBE_PORT is not set, so no independent listener is running. Set it (e.g. 10009) and restart to prove whether the OS delivers datagrams to this process at all.";
  if (Number.isInteger(probePort) && probePort > 0) {
    probe = new UdpProbe({
      port: probePort,
      multicastGroup: process.env.SUPREME_LAN_PROBE_MULTICAST_GROUP || undefined,
      multicastInterface: process.env.SUPREME_LAN_PROBE_MULTICAST_INTERFACE || undefined,
    });
    try {
      await probe.start();
      probeDisabledReason = null;
      // eslint-disable-next-line no-console
      console.log(`[supreme-lan] independent UDP probe listening on ${probe.snapshot().boundAddress}:${probe.snapshot().boundPort} (no decoder, no NATS republish)`);
    } catch (err) {
      // A probe that cannot bind must say so — its snapshot still reports the error, but the
      // service itself keeps running: the probe is a diagnostic, never a startup dependency.
      probeDisabledReason = `The independent UDP probe failed to bind port ${probePort}: ${err instanceof Error ? err.message : String(err)}`;
      // eslint-disable-next-line no-console
      console.error(`[supreme-lan] ${probeDisabledReason}`);
    }
  }

  const forensicsSub = await handleRequests<LanForensicsRequest, LanForensicsResponse>(
    bus,
    lanSubjects.forensics,
    async () => collectForensics(),
    () => ({ network: null, sockets: [], probe: null, probeDisabledReason: "Forensics could not be collected." }),
  );

  async function collectForensics(): Promise<LanForensicsResponse> {
    const network = await collectNetworkForensics(deployment);
    return {
      network,
      sockets: server.sessionForensics(network.udpSockets),
      probe: probe ? probe.snapshot() : null,
      probeDisabledReason,
    };
  }

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
    forensicsSub.unsubscribe();
    await probe?.stop();
    await server.stop();
    await bus.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

void main();
