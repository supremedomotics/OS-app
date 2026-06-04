import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppContext } from "./context.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHomeRoutes } from "./routes/home.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerSceneRoutes } from "./routes/scenes.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerInstallerRoutes } from "./routes/installer.js";
import { registerPhase3Routes } from "./routes/phase3.js";
import { attachStream } from "./stream.js";

/**
 * The Supreme API Gateway / BFF (§6). The ONLY client-facing surface. Every route
 * speaks pure Supreme contracts — there is zero HA leakage by construction because
 * the gateway never imports anything HA-specific; it only talks to the SIL facade
 * and the Supreme domain services.
 */
export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: ctx.config.logLevel } });

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

  app.get("/healthz", async () => ({
    status: "ok",
    backend: ctx.sil.backendKind,
    backendHealthy: ctx.sil.isHealthy(),
  }));

  registerAuthRoutes(app, ctx);
  registerHomeRoutes(app, ctx);
  registerDeviceRoutes(app, ctx);
  registerSceneRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);
  registerInstallerRoutes(app, ctx);
  registerPhase3Routes(app, ctx);
  attachStream(app, ctx);

  return app;
}

export { authenticate } from "./auth.js";
