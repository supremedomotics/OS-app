import { readFileSync } from "node:fs";
import { generateSigningKeyPair } from "@supreme/crypto";
import { DevHubCA } from "@supreme/hub-identity";
import { buildHubRegistryServer } from "./server.js";

/**
 * Hub Registry entry point. The Hub CA keypair is loaded from the cloud secrets store
 * (`SUPREME_HUB_CA_KEY_FILE` / `SUPREME_HUB_CA_PUB_FILE`, PEM) — in production an HSM/KMS-
 * backed X.509 issuing CA replaces {@link DevHubCA} behind the same seam. With no key
 * configured (dev), a throwaway CA is generated so the service runs standalone.
 *
 * OPTIONAL cloud infrastructure — the hub provisions and runs in-home without it.
 */
function loadCa(): DevHubCA {
  const keyFile = process.env.SUPREME_HUB_CA_KEY_FILE;
  const pubFile = process.env.SUPREME_HUB_CA_PUB_FILE;
  if (keyFile && pubFile) {
    return new DevHubCA({
      caPrivateKey: readFileSync(keyFile, "utf8"),
      caPublicKey: readFileSync(pubFile, "utf8"),
      keyId: process.env.SUPREME_HUB_CA_KEY_ID ?? "hub-ca-1",
    });
  }
  const kp = generateSigningKeyPair();
  return new DevHubCA({ caPrivateKey: kp.privateKey, caPublicKey: kp.publicKey });
}

async function main(): Promise<void> {
  const app = buildHubRegistryServer({
    ca: loadCa(),
    brokerEndpoint: process.env.SUPREME_BROKER_ENDPOINT ?? "https://broker.supreme.example",
    logLevel: process.env.SUPREME_LOG_LEVEL ?? "info",
  });
  const port = Number(process.env.HUB_REGISTRY_PORT ?? 8092);
  await app.listen({ host: "0.0.0.0", port });
}

main().catch((err) => {
  console.error("fatal: hub-registry failed to start", err);
  process.exit(1);
});
