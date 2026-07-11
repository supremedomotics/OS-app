import { httpStatusFor, SupremeError, type ApiError } from "@supreme/contracts";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

/**
 * Map any thrown error to the canonical Supreme {@link ApiError} envelope and the
 * correct HTTP status. Zod validation failures become a structured 422 so clients
 * get field-level detail (§6 error model).
 */
export function sendError(reply: FastifyReply, err: unknown, traceId?: string): void {
  if (err instanceof SupremeError) {
    reply.code(httpStatusFor(err.code)).send(err.toApiError(traceId));
    return;
  }
  if (err instanceof ZodError) {
    const body: ApiError = {
      code: "validation_failed",
      message: "request validation failed",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      traceId,
    };
    reply.code(422).send(body);
    return;
  }
  // Anything that isn't a SupremeError/ZodError is a genuine bug, not an expected client-facing
  // failure — the client only ever sees the generic "internal error" (§6 error model doesn't leak
  // internals), so without logging it here, the real cause is lost entirely, server-side included.
  reply.log.error({ err }, "unhandled error");
  const body: ApiError = { code: "internal", message: "internal error", traceId };
  reply.code(500).send(body);
}
