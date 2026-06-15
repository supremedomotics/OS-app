import { connectionStorm, faultBackend, runLoad, seedSession, startHub } from "./harness.js";

/**
 * Load / soak / chaos CLI. Examples:
 *   pnpm --filter @supreme/tools-loadtest run -- load          # default 50 VUs, 10s
 *   VUS=100 DURATION_MS=600000 pnpm ... run -- soak            # 10-minute soak (watch RSS)
 *   pnpm ... run -- chaos                                      # baseline → fault → recover
 */
const mode = process.argv[2] ?? "load";
const vus = Number(process.env.VUS ?? 50);
const durationMs = Number(process.env.DURATION_MS ?? (mode === "soak" ? 600_000 : 10_000));

async function main(): Promise<void> {
  const hub = await startHub();
  const session = await seedSession(hub.baseUrl);
  console.log(`hub up ${hub.baseUrl} | mode=${mode} vus=${vus} duration=${durationMs}ms`);
  try {
    if (mode === "chaos") {
      const baseline = await runLoad({ baseUrl: hub.baseUrl, session, vus, durationMs: 3000 });
      console.log("baseline       :", fmt(baseline));
      const restore = await faultBackend(hub.ctx);
      const during = await runLoad({ baseUrl: hub.baseUrl, session, vus, durationMs: 3000 });
      console.log("during outage  :", fmt(during), "(errors expected)");
      await restore();
      const recovered = await runLoad({ baseUrl: hub.baseUrl, session, vus, durationMs: 3000 });
      console.log("after recovery :", fmt(recovered));
    } else {
      const result = await runLoad({ baseUrl: hub.baseUrl, session, vus, durationMs });
      console.log("result         :", fmt(result));
      const storm = await connectionStorm({ wsBaseUrl: hub.wsBaseUrl, session, count: 200 });
      console.log(`connection storm: ${storm}/200 WSS connected`);
    }
  } finally {
    await hub.stop();
  }
}

function fmt(r: { rps: number; p50: number; p95: number; p99: number; errorRate: number; rssStartMb?: number; rssEndMb?: number }): string {
  const mem = r.rssStartMb != null ? ` rss ${r.rssStartMb}→${r.rssEndMb}MB` : "";
  return `rps=${r.rps} p50=${r.p50} p95=${r.p95} p99=${r.p99}ms err=${(r.errorRate * 100).toFixed(2)}%${mem}`;
}

main().catch((err) => {
  console.error("loadtest failed", err);
  process.exit(1);
});
