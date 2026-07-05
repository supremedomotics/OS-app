import { SupremeError } from "@supreme/contracts";
import type { Action, Device, ResourceType, User } from "@supreme/domain-model";
import type { FastifyRequest } from "fastify";
import type { AppContext } from "./context.js";

/** Extract and validate the Bearer access token; returns the live user. */
export async function authenticate(ctx: AppContext, req: FastifyRequest): Promise<User> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new SupremeError("unauthorized", "missing bearer token");
  }
  return ctx.identity.authenticate(header.slice("Bearer ".length));
}

/** Authorize an action, throwing a typed 403 when denied (async grants). */
export async function enforce(
  ctx: AppContext,
  user: User,
  resourceType: ResourceType,
  resourceId: string | null,
  action: Action,
): Promise<void> {
  const grants = await ctx.grantsFor(user.id);
  ctx.policy.enforce({ user, resourceType, resourceId, action }, grants);
}

/** Non-throwing access check used to filter list responses. */
export async function can(
  ctx: AppContext,
  user: User,
  resourceType: ResourceType,
  resourceId: string | null,
  action: Action,
): Promise<boolean> {
  const grants = await ctx.grantsFor(user.id);
  return ctx.policy.decide({ user, resourceType, resourceId, action }, grants).allowed;
}

export async function canViewDevice(ctx: AppContext, user: User, device: Device): Promise<boolean> {
  return can(ctx, user, "device", device.id, "view");
}
