import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSecureConfig, DEV_TOKEN_SECRET, loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Security-hardening checks (production-readiness §1): security headers, a strict
 * auth rate limit, and fail-closed config validation.
 */
describe("Gateway security hardening", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;

  beforeAll(async () => {
    // Tiny auth limit so the brute-force guard trips quickly in the test.
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent", SUPREME_AUTH_RATE_MAX: "3" }));
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

  it("sets standard security headers (helmet)", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBeTruthy();
  });

  it("rate-limits credential endpoints to blunt brute force", async () => {
    const attempt = () =>
      fetch(`${baseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x@y.z", password: "wrong" }),
      });
    // authRateMax = 3 → the 4th attempt within the window is throttled.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await attempt()).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("fails closed in production with insecure defaults", () => {
    expect(() =>
      assertSecureConfig({ ...loadConfig({}), nodeEnv: "production", tokenSecret: DEV_TOKEN_SECRET }),
    ).toThrow(/refusing to boot/);
    // A strong secret + explicit CORS origins passes.
    expect(() =>
      assertSecureConfig({
        ...loadConfig({}),
        nodeEnv: "production",
        tokenSecret: "x".repeat(40),
        corsOrigins: ["https://app.supreme.example"],
      }),
    ).not.toThrow();
  });
});
