import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Observability (production-readiness §6): the gateway exposes a Prometheus
 * /metrics endpoint that reflects real traffic, and a dependency-aware /readyz
 * readiness probe.
 */
describe("Gateway observability", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  it("readyz reports ready (backend healthy; DB not configured in this slice)", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      checks: { backend: string; database: string };
    };
    expect(body.status).toBe("ready");
    expect(body.checks.backend).toBe("ok");
    expect(body.checks.database).toBe("not-configured");
  });

  it("exposes Prometheus metrics that count served requests", async () => {
    // Generate some traffic on a known route first.
    await fetch(`${baseUrl}/healthz`);
    await fetch(`${baseUrl}/healthz`);

    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();

    // Counter + histogram families are present and labelled by route template.
    expect(text).toContain("supreme_http_requests_total");
    expect(text).toMatch(/supreme_http_requests_total\{[^}]*route="\/healthz"[^}]*\}/);
    expect(text).toContain("supreme_http_request_duration_seconds_bucket");
    expect(text).toContain("supreme_process_uptime_seconds");
  });
});
