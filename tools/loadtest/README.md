# @supreme/tools-loadtest — load / soak / chaos harness (§5, §15)

Drives the Supreme gateway concurrently and measures rps, latency (p50/p95/p99),
error rate, RSS, WSS connection capacity, and fault recovery.

## In-process (default) — boots its own gateway; supports automated backend-fault chaos
```bash
pnpm --filter @supreme/tools-loadtest run -- load          # 50 VUs, 10s + WSS storm
pnpm --filter @supreme/tools-loadtest run -- chaos         # baseline → fault backend → recover
pnpm --filter @supreme/tools-loadtest test                 # fast CI gate (asserts thresholds)
```

## Against a REAL deployed hub — `--url` / `TARGET_URL`
```bash
pnpm ... run -- load  --url https://hub.local --vus 100 --duration 60000
pnpm ... run -- soak  --url https://hub.local --duration 600000 --window 5000   # per-window, 10 min
pnpm ... run -- chaos --url https://hub.local                                   # operator induces faults
```

Notes for an external target:
- It must allow the demo login (or adapt `seedSession`) and have raised rate limits if
  you want to measure the server, not the limiter.
- **RSS reported is the load client's**, not the hub's — watch rps/latency/error-rate for
  the remote signal; sample the hub's own `/metrics`
  (`supreme_process_resident_memory_bytes`) for its memory.
- **Automated backend faulting is in-process only.** For a real hub, induce the fault
  yourself (e.g. `docker compose stop homeassistant`) during a `soak`/`chaos` run and
  watch the per-window error rate spike then recover.

CI: `.github/workflows/loadtest.yml` runs the gate on push + a heavier run nightly/manual.
