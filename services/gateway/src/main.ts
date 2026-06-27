import { loadConfig } from "./config.js";
import { createHubContext } from "./bootstrap.js";
import { buildServer } from "./server.js";
import { initTracing } from "./tracing.js";
import { RelayTunnelClient } from "./relay-tunnel.js";
import { OtaChecker } from "./ota.js";
import { HubAgent } from "./hub-agent.js";
import { createSecretStore } from "./secrets.js";

/**
 * Hub entry point for the Supreme API Gateway. Boots the Supreme plane (identity,
 * permissions, SIL) and serves REST + WSS. Phase 0 runs the mock backend so the
 * full path is exercisable with no HA or hardware (§19).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  // Tracing first so the very first request is instrumented (no-op unless configured).
  const stopTracing = initTracing({
    endpoint: config.otelEndpoint,
    serviceName: "supreme-gateway",
    serviceVersion: config.hubVersion,
  });
  const ctx = await createHubContext(config);
  const app = await buildServer(ctx);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await ctx.shutdown();
    await stopTracing();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Drive time/interval automation triggers once a minute.
  const tick = setInterval(() => void ctx.automations.tick(), 60_000);
  tick.unref();

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { backend: config.backend, port: config.port },
    "Supreme API Gateway listening",
  );

  // Remote access (§8): dial out to the cloud relay and hold the tunnel open. Outbound
  // only — no inbound ports. Off-LAN clients reach this hub through the relay.
  if (config.relayUrl && config.relayToken) {
    const tunnel = new RelayTunnelClient({
      relayUrl: config.relayUrl,
      homeId: ctx.homeId,
      token: config.relayToken,
      localBaseUrl: `http://127.0.0.1:${config.port}`,
    });
    tunnel.start();
    app.log.info({ relay: config.relayUrl }, "remote-access tunnel started");
  }

  // Zero-touch cloud provisioning (ADR 0008): on boot, generate the hub's cryptographic
  // identity (once) and enroll with the cloud Hub Registry. Non-fatal and outbound-only —
  // the hub runs fully locally if the cloud is unreachable (invariant I1). Until the owner
  // claims the hub, we surface a claim code in the logs (the Setup Wizard renders it in-app).
  if (config.hubRegistryUrl) {
    const agent = new HubAgent({
      store: createSecretStore(config.secretsDir || undefined),
      registryUrl: config.hubRegistryUrl,
      model: config.hubModel,
      fwVersion: config.hubVersion,
      log: (msg, meta) => app.log.info(meta ?? {}, msg),
    });
    const provision = async () => {
      const state = await agent.ensureEnrolled();
      if (state.enrolled) {
        const claim = await agent.requestClaimCode();
        if (claim) app.log.info({ hubUuid: agent.hubUuid, claimCode: claim.code }, "hub awaiting owner claim");
      }
    };
    void provision();
    // Re-check periodically to renew the credential before expiry and keep presence fresh.
    const enrollTimer = setInterval(() => void provision(), 6 * 60 * 60 * 1000);
    enrollTimer.unref();
  }

  // OTA (§14): periodically check the signed release channel and log when an update is
  // available. Detection only — the OS updater applies it (staged + rollback-safe).
  if (config.otaUrl && config.otaPublicKey) {
    const ota = new OtaChecker({
      url: config.otaUrl,
      publicKeyPem: config.otaPublicKey,
      currentVersion: config.hubVersion,
    });
    const checkOta = () =>
      void ota
        .check()
        .then((r) => {
          if (r.updateAvailable) app.log.info({ latest: r.latest?.version }, "hub update available");
        })
        .catch((err) => app.log.warn({ err: (err as Error).message }, "ota check failed"));
    checkOta();
    const otaTimer = setInterval(checkOta, 6 * 60 * 60 * 1000);
    otaTimer.unref();
  }
}

main().catch((err) => {
  console.error("fatal: gateway failed to start", err);
  process.exit(1);
});
