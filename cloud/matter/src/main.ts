import { buildMatterServer } from "./server.js";

/**
 * Cloud Matter service entry point (blueprint §9). OPTIONAL — Matter runs on the hub without it;
 * this only brokers fabric/multi-admin metadata. Per-hub API keys map to a homeId:
 *   MATTER_API_KEYS   `key1:home1,key2:home2` (issued per hub at enrollment).
 *   MATTER_PORT       listen port (default 8096).
 */
function parseApiKeys(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    // Split on the first colon only — keys may themselves contain no colon, but be defensive.
    const i = pair.indexOf(":");
    if (i <= 0) continue;
    const key = pair.slice(0, i);
    const home = pair.slice(i + 1);
    if (key && home) map.set(key, home);
  }
  return map;
}

async function main(): Promise<void> {
  // Fail closed: never boot with a known default key in production. Set MATTER_API_KEYS, or opt into
  // the demo key explicitly with MATTER_DEV=1.
  const raw = process.env.MATTER_API_KEYS ?? (process.env.MATTER_DEV === "1" ? "dev-matter-key:home_demo" : "");
  const apiKeys = parseApiKeys(raw);
  if (apiKeys.size === 0) throw new Error("MATTER_API_KEYS is required (or set MATTER_DEV=1 for the demo key)");
  const app = buildMatterServer({ apiKeys, logLevel: process.env.MATTER_LOG_LEVEL ?? "info" });
  const port = Number(process.env.MATTER_PORT ?? 8096);
  await app.listen({ host: "0.0.0.0", port });
}

main().catch((err) => {
  console.error("fatal: matter cloud service failed to start", err);
  process.exit(1);
});
