import type { EnrollmentRequest } from "@supreme/hub-identity";
import Fastify, { type FastifyInstance } from "fastify";
import { HubRegistry, RegistryError, type HubRegistryOptions } from "./index.js";

/**
 * Cloud Hub Registry HTTP API (ADR 0008). Wraps the transport-agnostic {@link HubRegistry}
 * core. This is the endpoint a hub hits during zero-touch provisioning:
 *
 *   POST /v1/hubs/enroll              — hub submits a signed CSR-equivalent → device credential
 *   POST /v1/hubs/renew               — hub renews its credential (proof-of-possession)
 *   POST /v1/hubs/:id/claim-code      — issue a proximity-gated claim code
 *   POST /v1/hubs/:id/claim           — an authenticated owner binds the hub (→ home + owner)
 *   POST /v1/hubs/:id/transfer        — owner/dealer hands the hub to another account
 *   POST /v1/hubs/:id/heartbeat       — liveness
 *   GET  /v1/hubs?account=…           — list an account's hubs
 *
 * Auth note: enroll/renew are authenticated by the hub's signed request (the body itself is a
 * proof-of-possession; mTLS device-cert auth is layered on at the edge in production). Claim
 * and transfer require a Supreme user session — modelled here via `X-Account-Id`, replaced by
 * a verified AuthN access token at the edge. Claim-code issuance is proximity-gated in
 * production (LAN challenge / dealer token); kept open in dev for the end-to-end flow.
 */
export interface HubRegistryServerOptions extends HubRegistryOptions {
  logLevel?: string;
}

const STATUS: Record<RegistryError["code"], number> = {
  validation_failed: 422,
  conflict: 409,
  not_found: 404,
  unauthorized: 401,
};

export function buildHubRegistryServer(opts: HubRegistryServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: { level: opts.logLevel ?? "info" }, bodyLimit: 256_000 });
  const registry = new HubRegistry(opts);

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof RegistryError) {
      reply.code(STATUS[err.code]).send({ code: err.code, message: err.message });
      return;
    }
    reply.code(500).send({ code: "internal", message: err.message });
  });

  const accountOf = (headers: Record<string, unknown>): string => {
    const id = headers["x-account-id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new RegistryError("unauthorized", "missing account session");
    }
    return id;
  };

  app.get("/healthz", async () => ({ status: "ok", service: "hub-registry" }));

  app.post("/v1/hubs/enroll", async (req, reply) => {
    reply.code(201).send(await registry.enroll(req.body as EnrollmentRequest));
  });

  app.post("/v1/hubs/renew", async (req, reply) => {
    reply.code(200).send(await registry.renew(req.body as EnrollmentRequest));
  });

  app.post<{ Params: { id: string } }>("/v1/hubs/:id/claim-code", async (req, reply) => {
    reply.code(201).send(await registry.issueClaimCode(req.params.id));
  });

  app.post<{ Params: { id: string } }>("/v1/hubs/:id/claim", async (req, reply) => {
    const accountId = accountOf(req.headers as Record<string, unknown>);
    const body = (req.body ?? {}) as { code?: string; homeName?: string };
    if (typeof body.code !== "string") throw new RegistryError("validation_failed", "claim code required");
    reply.code(201).send(await registry.claim(req.params.id, accountId, body.code, body.homeName));
  });

  app.post<{ Params: { id: string } }>("/v1/hubs/:id/transfer", async (req, reply) => {
    accountOf(req.headers as Record<string, unknown>); // must be authenticated (owner/dealer)
    const body = (req.body ?? {}) as { toAccountId?: string };
    if (typeof body.toAccountId !== "string") throw new RegistryError("validation_failed", "toAccountId required");
    await registry.transfer(req.params.id, body.toAccountId);
    reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/hubs/:id/heartbeat", async (req, reply) => {
    await registry.heartbeat(req.params.id);
    reply.code(204).send();
  });

  app.get("/v1/hubs", async (req, reply) => {
    const accountId = accountOf(req.headers as Record<string, unknown>);
    reply.send({ hubs: await registry.listHubsForAccount(accountId) });
  });

  return app;
}
