import {
  CreateGrantRequest,
  CreateUserRequest,
  type GrantList,
  type GrantResponse,
  type UserList,
  type UserResponse,
} from "@supreme/contracts";
import type { UserId } from "@supreme/domain-model";
import { ASSIGNABLE_ROLES } from "@supreme/permissions";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/** User management + grants — the master/admin flow (§8). */
export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  // The assignable roles for the "Create New User" form (the spec's 7), with labels.
  app.get("/v1/roles", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "user", null, "view");
      reply.send({ roles: ASSIGNABLE_ROLES });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/users", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "user", null, "view");
      const body: UserList = { users: await ctx.identity.listUsers() };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/users", async (req, reply) => {
    try {
      const actor = await authenticate(ctx, req);
      await enforce(ctx, actor, "user", null, "create");
      const input = CreateUserRequest.parse(req.body);
      const user = await ctx.identity.createUser(input);
      const body: UserResponse = { user };
      reply.code(201).send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/users/:id/suspend", async (req, reply) => {
    try {
      const actor = await authenticate(ctx, req);
      await enforce(ctx, actor, "user", req.params.id, "admin");
      const user = await ctx.identity.setUserStatus(req.params.id as UserId, "suspended");
      const body: UserResponse = { user };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/users/:id/reactivate", async (req, reply) => {
    try {
      const actor = await authenticate(ctx, req);
      await enforce(ctx, actor, "user", req.params.id, "admin");
      const user = await ctx.identity.setUserStatus(req.params.id as UserId, "active");
      const body: UserResponse = { user };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Grants (time-based / temporary access) ───────────────────────────────────
  app.get<{ Params: { id: string } }>("/v1/users/:id/grants", async (req, reply) => {
    try {
      const actor = await authenticate(ctx, req);
      await enforce(ctx, actor, "user", req.params.id, "view");
      const body: GrantList = { grants: await ctx.grantsFor(req.params.id as UserId) };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/users/:id/grants", async (req, reply) => {
    try {
      const actor = await authenticate(ctx, req);
      await enforce(ctx, actor, "user", req.params.id, "admin");
      const input = CreateGrantRequest.parse(req.body);
      const grant = await ctx.addGrant({ userId: req.params.id as UserId, ...input });
      const body: GrantResponse = { grant };
      reply.code(201).send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });
}
