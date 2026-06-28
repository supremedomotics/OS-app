import fastifyWebsocket from "@fastify/websocket";
import fastifyHelmet from "@fastify/helmet";
import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppContext } from "./context.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerHomeRoutes } from "./routes/home.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerSceneRoutes } from "./routes/scenes.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerInstallerRoutes } from "./routes/installer.js";
import { registerPhase3Routes } from "./routes/phase3.js";
import { registerSecurityRoutes } from "./routes/security.js";
import { registerMigrationRoutes } from "./routes/migration.js";
import { registerMatterRoutes } from "./routes/matter.js";
import { attachObservability } from "./observability.js";
import { attachStream } from "./stream.js";

/**
 * The Supreme API Gateway / BFF (§6). The ONLY client-facing surface. Every route
 * speaks pure Supreme contracts — there is zero HA leakage by construction because
 * the gateway never imports anything HA-specific; it only talks to the SIL facade
 * and the Supreme domain services.
 */
export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  // 1 MB body cap blunts oversized-payload abuse on the JSON API.
  const app = Fastify({ logger: { level: ctx.config.logLevel }, bodyLimit: 1_048_576 });

  // ── Security middleware (§ production hardening) ──────────────────────────────
  // Standard hardening headers (HSTS, no-sniff, frame-deny, etc.).
  await app.register(fastifyHelmet, { contentSecurityPolicy: false });
  // CORS allow-list: explicit origins in production; permissive in dev only.
  await app.register(fastifyCors, {
    origin:
      ctx.config.corsOrigins.length > 0
        ? ctx.config.corsOrigins
        : ctx.config.nodeEnv === "production"
          ? false
          : true,
    credentials: true,
  });
  // Rate limiting: a generous global ceiling; auth routes opt into a stricter cap.
  await app.register(fastifyRateLimit, {
    global: true,
    max: ctx.config.rateMax,
    timeWindow: "1 minute",
  });

  // Tolerate empty bodies on action POSTs (e.g. scene activate, user suspend) that
  // still carry a JSON content-type — treat them as an undefined body, not an error.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const text = (body as string).trim();
      if (text.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  await app.register(fastifyWebsocket);

  // Metrics collection + /metrics scrape endpoint + dependency-aware /readyz (§6).
  attachObservability(app, ctx);

  app.get("/healthz", async () => ({
    status: "ok",
    backend: ctx.sil.backendKind,
    backendHealthy: ctx.sil.isHealthy(),
  }));

  registerSetupRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerHomeRoutes(app, ctx);
  registerDeviceRoutes(app, ctx);
  registerSceneRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);
  registerInstallerRoutes(app, ctx);
  registerPhase3Routes(app, ctx);
  registerSecurityRoutes(app, ctx);
  registerMigrationRoutes(app, ctx);
  registerMatterRoutes(app, ctx);
  attachStream(app, ctx);

  return app;
}

export { authenticate } from "./auth.js";
