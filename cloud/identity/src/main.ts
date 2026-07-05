import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { AuthnService } from "@supreme/cloud-authn";
import { DeviceRegistry } from "@supreme/device-registry";
import { IdentityService } from "./index.js";
import { buildIdentityServer } from "./server.js";

/**
 * Identity-plane entry point. The AuthN signing key (Ed25519 PEM) is loaded from the cloud
 * secrets store (`SUPREME_AUTHN_KEY_FILE`); with none configured (dev) a throwaway key is
 * generated so the service runs standalone. OPTIONAL cloud infrastructure — the hub provisions
 * and runs in-home without it.
 */
function loadAuthn(): AuthnService {
  const keyFile = process.env.SUPREME_AUTHN_KEY_FILE;
  if (keyFile) {
    const pem = readFileSync(keyFile, "utf8");
    const privateKey = createPrivateKey(pem);
    return new AuthnService({ privateKey, publicKey: createPublicKey(privateKey), keyId: process.env.SUPREME_AUTHN_KEY_ID ?? "authn-1", issuer: process.env.SUPREME_AUTHN_ISSUER });
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return new AuthnService({ publicKey, privateKey, issuer: process.env.SUPREME_AUTHN_ISSUER });
}

async function main(): Promise<void> {
  const authn = loadAuthn();
  const app = buildIdentityServer({
    identity: new IdentityService(),
    authn,
    devices: new DeviceRegistry({ revokeSession: (sid) => authn.revokeSession(sid) }),
    logLevel: process.env.SUPREME_LOG_LEVEL ?? "info",
  });
  const port = Number(process.env.IDENTITY_PORT ?? 8093);
  await app.listen({ host: "0.0.0.0", port });
}

main().catch((err) => {
  console.error("fatal: identity service failed to start", err);
  process.exit(1);
});
