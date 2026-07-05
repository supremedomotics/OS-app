import { buildFleetServer } from "./server.js";

/**
 * Cloud fleet service entry point. API keys are provided as `FLEET_API_KEYS` in the
 * form `key1:org1,key2:org2`. This is OPTIONAL cloud infrastructure; the hub runs
 * without it.
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
  const apiKeys = parseApiKeys(process.env.FLEET_API_KEYS ?? "dev-fleet-key:org_demo");
  const app = buildFleetServer({ apiKeys, logLevel: process.env.FLEET_LOG_LEVEL ?? "info" });
  const port = Number(process.env.FLEET_PORT ?? 8090);
  await app.listen({ host: "0.0.0.0", port });
}

main().catch((err) => {
  console.error("fatal: fleet service failed to start", err);
  process.exit(1);
});
