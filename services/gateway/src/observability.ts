import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "./context.js";

/**
 * Observability (production-readiness §6). A self-contained Prometheus metrics
 * registry + a real readiness probe — no external dependency (same node-only
 * stance as the TOTP/crypto code). Exposes:
 *
 *   GET /metrics  → Prometheus text exposition (request counts/latency + process)
 *   GET /readyz   → readiness: SIL backend healthy AND (if configured) DB reachable
 *
 * `/healthz` stays a cheap liveness probe; `/readyz` is the dependency-aware
 * readiness probe an orchestrator should gate traffic on.
 */

type Labels = Record<string, string>;

function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  const inner = keys
    .map((k) => `${k}="${(labels[k] ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
  return `{${inner}}`;
}

/** A labelled monotonic counter. */
class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = renderLabels(labels);
    const cur = this.values.get(key);
    if (cur) cur.value += by;
    else this.values.set(key, { labels, value: by });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

/** A labelled cumulative histogram with fixed buckets (seconds). */
class Histogram {
  private static readonly BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  private readonly series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  observe(labels: Labels, value: number): void {
    const key = renderLabels(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: new Array(Histogram.BUCKETS.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < Histogram.BUCKETS.length; i++) {
      if (value <= (Histogram.BUCKETS[i] as number)) s.counts[i] = (s.counts[i] as number) + 1;
    }
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      let cumulative = 0;
      for (let i = 0; i < Histogram.BUCKETS.length; i++) {
        cumulative += s.counts[i] as number;
        lines.push(
          `${this.name}_bucket${renderLabels({ ...s.labels, le: String(Histogram.BUCKETS[i]) })} ${cumulative}`,
        );
      }
      lines.push(`${this.name}_bucket${renderLabels({ ...s.labels, le: "+Inf" })} ${s.count}`);
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return lines.join("\n");
  }
}

/** The gateway's metric registry. */
export class Metrics {
  readonly httpRequests = new Counter(
    "supreme_http_requests_total",
    "Total HTTP requests by method, route, and status code.",
  );
  readonly httpDuration = new Histogram(
    "supreme_http_request_duration_seconds",
    "HTTP request latency in seconds by method and route.",
  );

  /** Prometheus text exposition for everything, including live process gauges. */
  render(): string {
    const mem = process.memoryUsage();
    const process_metrics = [
      "# HELP supreme_process_uptime_seconds Process uptime in seconds.",
      "# TYPE supreme_process_uptime_seconds gauge",
      `supreme_process_uptime_seconds ${process.uptime()}`,
      "# HELP supreme_process_resident_memory_bytes Resident memory size in bytes.",
      "# TYPE supreme_process_resident_memory_bytes gauge",
      `supreme_process_resident_memory_bytes ${mem.rss}`,
      "# HELP supreme_nodejs_heap_used_bytes V8 heap used in bytes.",
      "# TYPE supreme_nodejs_heap_used_bytes gauge",
      `supreme_nodejs_heap_used_bytes ${mem.heapUsed}`,
    ].join("\n");
    return [this.httpRequests.render(), this.httpDuration.render(), process_metrics].join("\n") + "\n";
  }
}

/**
 * Attach metrics collection + the `/metrics` and `/readyz` endpoints. Records one
 * counter increment and one latency observation per response, keyed by the route
 * *template* (not the raw URL) to keep cardinality bounded.
 */
export function attachObservability(app: FastifyInstance, ctx: AppContext): Metrics {
  const metrics = new Metrics();
  const startKey = Symbol("supreme.start");

  app.addHook("onRequest", async (req) => {
    (req as unknown as Record<symbol, number>)[startKey] = performance.now();
  });

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    // The route template (e.g. "/v1/devices/:id/command") keeps label cardinality
    // bounded; the raw URL would explode it. Unmatched routes collapse to the URL
    // path without a query string.
    const route = req.routeOptions?.url ?? req.url.split("?")[0] ?? req.url;
    const method = req.method;
    const status = String(reply.statusCode);
    metrics.httpRequests.inc({ method, route, status });
    const started = (req as unknown as Record<symbol, number>)[startKey];
    if (typeof started === "number") {
      metrics.httpDuration.observe({ method, route }, (performance.now() - started) / 1000);
    }
  });

  // Scrape endpoint. Excluded from auth + (effectively) rate limiting so a
  // Prometheus scraper on the hub network can always read it.
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return metrics.render();
  });

  // Readiness: dependency-aware. Backend must be healthy and, when persistence is
  // configured, the database must answer a trivial query. Returns 503 when not
  // ready so an orchestrator holds traffic off.
  app.get("/readyz", async (_req, reply) => {
    const backendHealthy = ctx.sil.isHealthy();
    let dbReady = true;
    if (ctx.db) {
      try {
        await ctx.db.query("SELECT 1");
      } catch {
        dbReady = false;
      }
    }
    const ready = backendHealthy && dbReady;
    reply.code(ready ? 200 : 503);
    return {
      status: ready ? "ready" : "not-ready",
      checks: {
        backend: backendHealthy ? "ok" : "unhealthy",
        database: ctx.db ? (dbReady ? "ok" : "unreachable") : "not-configured",
      },
    };
  });

  return metrics;
}
