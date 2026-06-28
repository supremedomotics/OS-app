import { readFileSync } from "node:fs";
import { TunnelBroker } from "./broker.js";
import { createMtlsTunnelServer } from "./mtls.js";
import { buildTunnelBrokerServer } from "./server.js";

/**
 * Tunnel Broker entry point. Two surfaces share ONE routing core:
 *   • the HTTP/WS surface (`/v1/route/:hubId/*` for off-LAN clients), and
 *   • the real device-cert mTLS listener hubs dial out to (when broker certs are configured).
 *
 * mTLS requires the broker's server cert/key + the Hub CA cert (PEM) via env; without them only
 * the HTTP/WS surface runs (back-compat). OPTIONAL cloud infra — the hub runs in-home without it.
 */
function fileEnv(name: string): string | undefined {
  const path = process.env[name];
  return path ? readFileSync(path, "utf8") : undefined;
}

async function main(): Promise<void> {
  const pubFile = process.env.SUPREME_HUB_CA_PUB_FILE;
  if (!pubFile) throw new Error("SUPREME_HUB_CA_PUB_FILE (Hub CA public key) is required");
  const caPublicKey = readFileSync(pubFile, "utf8");

  // One broker core behind both surfaces.
  const broker = new TunnelBroker({ caPublicKey });
  const devAllowAll = process.env.SUPREME_BROKER_DEV_ALLOW_ALL === "1";
  const app = buildTunnelBrokerServer({
    caPublicKey,
    broker,
    authorizeClient: devAllowAll ? async () => true : undefined,
    logLevel: process.env.SUPREME_LOG_LEVEL ?? "info",
  });
  const port = Number(process.env.BROKER_PORT ?? 8094);
  await app.listen({ host: "0.0.0.0", port });

  // Real device-cert mTLS listener (the hub-initiated transport), if broker certs are provided.
  const cert = fileEnv("SUPREME_BROKER_CERT_FILE");
  const key = fileEnv("SUPREME_BROKER_KEY_FILE");
  const caCert = fileEnv("SUPREME_HUB_CA_CERT_FILE");
  if (cert && key && caCert) {
    const mtls = createMtlsTunnelServer({ cert, key, caCert, broker, log: (m, meta) => app.log.info(meta ?? {}, m) });
    const mtlsPort = Number(process.env.BROKER_MTLS_PORT ?? 8443);
    await mtls.listen(mtlsPort, "0.0.0.0");
    app.log.info({ mtlsPort }, "mTLS tunnel listener started");
  } else {
    app.log.warn("mTLS listener disabled (set SUPREME_BROKER_CERT_FILE/KEY_FILE + SUPREME_HUB_CA_CERT_FILE)");
  }
}

main().catch((err) => {
  console.error("fatal: tunnel-broker failed to start", err);
  process.exit(1);
});
