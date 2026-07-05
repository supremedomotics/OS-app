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
  const body: ApiError = { code: "internal", message: "internal error", traceId };
  reply.code(500).send(body);
}
