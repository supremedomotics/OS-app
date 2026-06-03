import { z } from "zod";

/**
 * Canonical Supreme error model. Every non-2xx REST response and every WSS error
 * frame uses this shape so clients have one error contract to handle. Codes are
 * stable strings (never HTTP-status-only) to survive transport changes (§6).
 */
export const ErrorCode = z.enum([
  "unauthorized",
  "forbidden",
  "not_found",
  "validation_failed",
  "conflict",
  "rate_limited",
  "backend_unavailable", // SIL could not reach the backend (e.g. HA reconnecting)
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  /** Optional field-level details for validation_failed. */
  details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  /** Correlation id for tracing across services. */
  traceId: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  rate_limited: 429,
  backend_unavailable: 503,
  internal: 500,
};

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

export class SupremeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: ApiError["details"],
  ) {
    super(message);
    this.name = "SupremeError";
  }

  toApiError(traceId?: string): ApiError {
    return { code: this.code, message: this.message, details: this.details, traceId };
  }
}
