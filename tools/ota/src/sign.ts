import { signPayload } from "@supreme/crypto";

/**
 * OTA release-manifest signer (§14). Reads the OTA Ed25519 private key + release inputs
 * from the environment and prints a SIGNED manifest to stdout. The hub verifies this
 * against its embedded OTA public key before reporting an update (see services/gateway
 * ota.ts). Run in CD: `OTA_SIGNING_KEY=… VERSION=0.4.0 pnpm --filter @supreme/tools-ota sign`.
 */
function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    process.stderr.write(`missing env ${name}\n`);
    process.exit(1);
  }
  return v;
}

const manifest = {
  channel: env("OTA_CHANNEL", "stable"),
  version: env("VERSION").replace(/^v/, ""),
  url: env("OTA_ARTIFACT_URL", `https://cdn.supreme/releases/hub-${env("VERSION").replace(/^v/, "")}.img`),
  sha256: env("OTA_ARTIFACT_SHA256", ""),
  notes: process.env.OTA_NOTES ?? "",
  releasedAt: new Date().toISOString(),
};

const privateKey = env("OTA_SIGNING_KEY").replace(/\\n/g, "\n");
const signed = { manifest, signature: signPayload(manifest, privateKey) };
process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
