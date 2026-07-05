import { generateSigningKeyPair } from "@supreme/crypto";
import { buildLicensingServer } from "./server.js";

/**
 * Cloud dealer-licensing service entry point. API keys are provided as `LICENSING_API_KEYS` in the
 * form `key1:dealerOrg1,key2:dealerOrg2`; the Ed25519 signing key as `LICENSING_PRIVATE_KEY` (PEM).
 * This is OPTIONAL cloud infrastructure — the hub validates its license offline and runs without it.
 * In production, back it with the {@link SqlLicenseRecordStore} (pass a node-postgres executor).
 */
function parseApiKeys(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [key, org] = pair.split(":");
    if (key && org) map.set(key, org);
  }
  return map;
}

async function main(): Promise<void> {
  const apiKeys = parseApiKeys(process.env.LICENSING_API_KEYS ?? "dev-dealer-key:org_demo");
  let privateKeyPem = process.env.LICENSING_PRIVATE_KEY;
  if (!privateKeyPem) {
    // Dev fallback: mint an ephemeral key so the service boots. Licenses signed with it verify only
    // against the matching public key printed below — set LICENSING_PRIVATE_KEY in production.
    const { privateKey, publicKey } = generateSigningKeyPair();
    privateKeyPem = privateKey;
    console.warn("LICENSING_PRIVATE_KEY not set — using an ephemeral dev key. Public key:\n" + publicKey);
  }

  const app = buildLicensingServer({
    apiKeys,
    privateKeyPem,
    logLevel: process.env.LICENSING_LOG_LEVEL ?? "info",
  });
  const port = Number(process.env.LICENSING_PORT ?? 8098);
  await app.listen({ host: "0.0.0.0", port });
}

main().catch((err) => {
  console.error("fatal: licensing service failed to start", err);
  process.exit(1);
});
