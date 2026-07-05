import type { HomeId } from "@supreme/domain-model";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  DealerLicensingError,
  DealerLicensingService,
  InMemoryLicenseRecordStore,
  type ILicenseRecordStore,
} from "./dealer-licensing.js";

/**
 * Cloud dealer-licensing HTTP API (§9 commercial) — OPTIONAL installer infrastructure. Multi-tenant
 * by dealer org: an API key maps to a dealer org. A dealer issues signed, hub-bound licenses for
 * their customers' hubs, activates / revokes / transfers them, and reads the issuance ledger + live
 * seat count. The hub never depends on this — it validates its token offline.
 */
export interface LicensingServerOptions {
  /** Ed25519 private key PEM used to sign issued licenses. */
  privateKeyPem: string;
  /** API key → dealer org id. In production these are issued per dealer org. */
  apiKeys: Map<string, string>;
  /** Pluggable ledger; defaults to in-memory (use {@link SqlLicenseRecordStore} in production). */
  store?: ILicenseRecordStore;
  logLevel?: string;
  now?: () => Date;
}

function badRequest(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

export function buildLicensingServer(opts: LicensingServerOptions): FastifyInstance {
  const app = Fastify({ logger: { level: opts.logLevel ?? "info" } });
  const store = opts.store ?? new InMemoryLicenseRecordStore();
  const svc = new DealerLicensingService(store, opts.privateKeyPem, opts.now);

  const orgOf = (req: FastifyRequest): string => {
    const header = req.headers.authorization;
    const key = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const orgId = opts.apiKeys.get(key);
    if (!orgId) {
      const err = new Error("invalid dealer API key") as Error & { statusCode: number };
      err.statusCode = 401;
      throw err;
    }
    return orgId;
  };

  // A record only belongs to the calling dealer — never let one org touch another's licenses.
  const ownedOr404 = async (orgId: string, id: string): Promise<void> => {
    const rec = await store.get(id);
    if (!rec || rec.dealerOrgId !== orgId) {
      const err = new Error("license record not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
  };

  app.setErrorHandler((err: Error, _req, reply) => {
    const status =
      (err as Error & { statusCode?: number }).statusCode ??
      (err instanceof DealerLicensingError ? 409 : 500);
    const code =
      status === 401 ? "unauthorized" : status === 404 ? "not_found" : status === 400 ? "bad_request" : status === 409 ? "conflict" : "internal";
    reply.code(status).send({ code, message: err.message });
  });

  app.get("/healthz", async () => ({ status: "ok", service: "licensing" }));

  // Issue a signed license for a customer hub.
  app.post("/v1/dealer/licenses", async (req, reply) => {
    const orgId = orgOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.homeId !== "string" || !body.homeId) throw badRequest("homeId is required");
    if (typeof body.sku !== "string" || !body.sku) throw badRequest("sku is required");
    if (body.seats !== undefined && (typeof body.seats !== "number" || body.seats < 1)) {
      throw badRequest("seats must be a positive number");
    }
    if (body.features !== undefined && !Array.isArray(body.features)) throw badRequest("features must be an array");
    const result = await svc.issue({
      dealerOrgId: orgId,
      homeId: body.homeId as HomeId,
      sku: body.sku,
      seats: typeof body.seats === "number" ? body.seats : undefined,
      features: Array.isArray(body.features) ? (body.features as string[]) : undefined,
      expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
    });
    reply.code(201).send(result);
  });

  // The dealer's issuance / activation ledger, newest first.
  app.get("/v1/dealer/licenses", async (req, reply) => {
    const orgId = orgOf(req);
    reply.send({ records: await svc.history(orgId) });
  });

  // Live seat count across activated licenses.
  app.get("/v1/dealer/seats", async (req, reply) => {
    const orgId = orgOf(req);
    reply.send({ seatsInUse: await svc.seatsInUse(orgId) });
  });

  app.post<{ Params: { id: string } }>("/v1/dealer/licenses/:id/activate", async (req, reply) => {
    const orgId = orgOf(req);
    await ownedOr404(orgId, req.params.id);
    reply.send({ record: await svc.markActivated(req.params.id) });
  });

  app.post<{ Params: { id: string } }>("/v1/dealer/licenses/:id/revoke", async (req, reply) => {
    const orgId = orgOf(req);
    await ownedOr404(orgId, req.params.id);
    reply.send({ record: await svc.revoke(req.params.id) });
  });

  app.post<{ Params: { id: string } }>("/v1/dealer/licenses/:id/transfer", async (req, reply) => {
    const orgId = orgOf(req);
    await ownedOr404(orgId, req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.newHomeId !== "string" || !body.newHomeId) throw badRequest("newHomeId is required");
    reply.send(await svc.transfer(req.params.id, body.newHomeId));
  });

  return app;
}
