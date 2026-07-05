import { buildBackupServer } from "./server.js";

/**
 * Off-site backup vault entry point (blueprint §13). OPTIONAL — the hub backs up/restores locally
 * without it. Per-hub API keys map to a homeId:
 *   BACKUPS_API_KEYS   `key1:home1,key2:home2` (issued per hub at enrollment).
 *   BACKUPS_PORT       listen port (default 8097).
 *   BACKUPS_RETENTION  backups kept per home (default 30).
 * The in-memory blob store is for dev; production injects an S3-compatible store.
 */
function parseApiKeys(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(":");
    if (i > 0) map.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return map;
}

async function main(): Promise<void> {
  const raw = process.env.BACKUPS_API_KEYS ?? (process.env.BACKUPS_DEV === "1" ? "dev-backup-key:home_demo" : "");
  const apiKeys = parseApiKeys(raw);
  if (apiKeys.size === 0) throw new Error("BACKUPS_API_KEYS is required (or set BACKUPS_DEV=1 for the demo key)");
  const app = buildBackupServer({
    apiKeys,
    retention: Number(process.env.BACKUPS_RETENTION ?? 30),
    logLevel: process.env.BACKUPS_LOG_LEVEL ?? "info",
  });
  const port = Number(process.env.BACKUPS_PORT ?? 8097);
  await app.listen({ host: "0.0.0.0", port });
}

main().catch((err) => {
  console.error("fatal: backup vault failed to start", err);
  process.exit(1);
});
