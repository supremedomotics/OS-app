import {
  connectionStorm,
  faultBackend,
  runLoad,
  runLoadWindows,
  seedSession,
  startHub,
  wsBaseFrom,
  type LoadResult,
  type Session,
} from "./harness.js";

/**
 * Load / soak / chaos CLI.
 *
 * In-process (default — boots its own gateway, supports automated backend-fault chaos):
 *   pnpm --filter @supreme/tools-loadtest run -- load
 *   pnpm ... run -- chaos
 *
 * Against a REAL deployed hub (`--url` or TARGET_URL — drives the live API):
 *   pnpm ... run -- load  --url https://hub.local  --vus 100 --duration 60000
 *   pnpm ... run -- soak  --url https://hub.local  --duration 600000   # 10-min, per-window
 *   pnpm ... run -- chaos --url https://hub.local                      # operator induces faults
 *
 * NOTE: against an external hub, RSS reported is the LOAD CLIENT's, not the hub's; the
 * meaningful remote signals are rps / latency / error-rate. Automated backend faulting
 * is in-process only — for a real hub, induce the fault yourself (e.g. stop the backend)
 * and watch the per-window error rate spike then recover.
 */
const mode = process.argv[2] ?? "load";
const url = arg("--url") ?? process.env.TARGET_URL;
const vus = Number(arg("--vus") ?? process.env.VUS ?? 50);
const durationMs = Number(arg("--duration") ?? process.env.DURATION_MS ?? (mode === "soak" ? 600_000 : 10_000));
const windowMs = Number(arg("--window") ?? process.env.WINDOW_MS ?? 3000);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fmt(r: LoadResult, remote: boolean): string {
  const mem = remote ? ` clientRss ${r.rssStartMb}→${r.rssEndMb}MB` : ` rss ${r.rssStartMb}→${r.rssEndMb}MB`;
  return `rps=${r.rps} p50=${r.p50} p95=${r.p95} p99=${r.p99}ms err=${(r.errorRate * 100).toFixed(2)}%${mem}`;
}

async function main(): Promise<void> {
  const remote = Boolean(url);
  const hub = remote ? null : await startHub();
  const baseUrl = url ?? hub!.baseUrl;
  const wsBaseUrl = remote ? wsBaseFrom(baseUrl) : hub!.wsBaseUrl;
  const session: Session = await seedSession(baseUrl);
  console.log(
    `target ${baseUrl} ${remote ? "(EXTERNAL)" : "(in-process)"} | mode=${mode} vus=${vus} duration=${durationMs}ms`,
  );

  try {
    if (mode === "chaos" && !remote) {
      // Automated: baseline → fault the backend → recover.
      console.log("baseline       :", fmt(await runLoad({ baseUrl, session, vus, durationMs: windowMs }), remote));
      const restore = await faultBackend(hub!.ctx);
      console.log("during outage  :", fmt(await runLoad({ baseUrl, session, vus, durationMs: windowMs }), remote), "(errors expected)");
      await restore();
      console.log("after recovery :", fmt(await runLoad({ baseUrl, session, vus, durationMs: windowMs }), remote));
    } else if (mode === "soak" || (mode === "chaos" && remote)) {
      // Per-window run: watch the error rate window-by-window (induce faults to test recovery).
      const windows = Math.max(1, Math.ceil(durationMs / windowMs));
      if (mode === "chaos") console.log("induce a fault on the hub during the run and watch err spike → recover");
      await runLoadWindows({ baseUrl, session, vus, durationMs: windowMs, windows }, (i, r) =>
        console.log(`window ${String(i + 1).padStart(3)}:`, fmt(r, remote)),
      );
    } else {
      console.log("result         :", fmt(await runLoad({ baseUrl, session, vus, durationMs }), remote));
      const count = Math.min(200, Math.max(20, vus * 2));
      console.log(`connection storm: ${await connectionStorm({ wsBaseUrl, session, count })}/${count} WSS connected`);
    }
  } finally {
    await hub?.stop();
  }
}

main().catch((err) => {
  console.error("loadtest failed", err);
  process.exit(1);
});
