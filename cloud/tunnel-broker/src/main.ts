import { readFileSync } from "node:fs";
import { buildTunnelBrokerServer } from "./server.js";

/**
 * Tunnel Broker entry point. Trusts the Hub CA public key (`SUPREME_HUB_CA_PUB_FILE`) to verify
 * hub device credentials. Client authorization (`authorizeClient`) is wired to the Identity/
 * AuthZ plane at the edge in production; here it defaults to fail-closed unless a dev allow-all
 * flag is set. OPTIONAL cloud infrastructure — the hub runs in-home without it.
 */
async function main(): Promise<void> {
  const pubFile = process.env.SUPREME_HUB_CA_PUB_FILE;
  if (!pubFile) throw new Error("SUPREME_HUB_CA_PUB_FILE (Hub CA public key) is required");
  const caPublicKey = readFileSync(pubFile, "utf8");

  const devAllowAll = process.env.SUPREME_BROKER_DEV_ALLOW_ALL === "1";
  const app = buildTunnelBrokerServer({
    caPublicKey,
    authorizeClient: devAllowAll ? async () => true : undefined,
    logLevel: process.env.SUPREME_LOG_LEVEL ?? "info",
  });
  const port = Number(process.env.BROKER_PORT ?? 8094);
  await app.listen({ host: "0.0.0.0", port });
}

main().catch((err) => {
  console.error("fatal: tunnel-broker failed to start", err);
  process.exit(1);
});
