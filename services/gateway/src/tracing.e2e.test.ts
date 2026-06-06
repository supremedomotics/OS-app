import type { FastifyInstance } from "fastify";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Distributed tracing (production-readiness §6). Registers an in-memory OTel provider
 * (the same global the gateway's tracer reads) and asserts that a request produces a
 * server span named by the resolved route template, with the status code attached.
 */
describe("Gateway tracing", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;

  beforeAll(async () => {
    provider.register();
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
    await provider.shutdown();
  });

  it("emits a server span per request named by route template + status", async () => {
    await fetch(`${baseUrl}/healthz`);

    const spans = exporter.getFinishedSpans();
    const healthz = spans.find((s) => s.name === "GET /healthz");
    expect(healthz).toBeDefined();
    expect(healthz?.attributes["http.route"]).toBe("/healthz");
    expect(healthz?.attributes["http.response.status_code"]).toBe(200);
  });
});
