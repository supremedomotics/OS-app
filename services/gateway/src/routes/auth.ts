import { LoginRequest, RefreshRequest } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { authenticate } from "../auth.js";
import { sendError } from "../http-errors.js";

/** Auth + current-user routes (§6, §12). Supreme-branded; no HA login surface. */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/v1/auth/login", async (req, reply) => {
    try {
      const body = LoginRequest.parse(req.body);
      reply.send(await ctx.identity.login(body.email, body.password));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/auth/refresh", async (req, reply) => {
    try {
      const body = RefreshRequest.parse(req.body);
      reply.send(await ctx.identity.refresh(body.refreshToken));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/me", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      reply.send({ user });
    } catch (err) {
      sendError(reply, err);
    }
  });
}
