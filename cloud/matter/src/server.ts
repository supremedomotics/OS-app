import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { MatterCloudService, MatterError, type IMatterStore } from "./index.js";

/**
 * Cloud Matter HTTP API (blueprint §9) — OPTIONAL. Brokers a home's Matter FABRIC state so it can
 * be multi-admin (Supreme hub + Apple Home / Google) and so fabric/node metadata is coordinated
 * centrally. The hub syncs here after it commissions a device locally; control still happens on the
 * hub. Not on the critical path — Matter works on the hub without this.
 *
 * Auth: a per-hub API key (issued at enrollment) maps to the hub's homeId, so a hub can only touch
 * its own fabric.
 */
export interface MatterServerOptions {
  store?: IMatterStore;
  now?: () => number;
  /** API key → homeId. In production these are issued per hub at enrollment. */
  apiKeys: Map<string, string>;
  logLevel?: string;
}

export function buildMatterServer(opts: MatterServerOptions): FastifyInstance {
  const app = Fastify({ logger: { level: opts.logLevel ?? "info" } });
  const matter = new MatterCloudService({ store: opts.store, now: opts.now });

  const homeOf = (req: FastifyRequest): string => {
    const header = req.headers.authorization;
    const key = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const homeId = opts.apiKeys.get(key);
    if (!homeId) {
      const err = new Error("invalid matter API key") as Error & { statusCode: number };
      err.statusCode = 401;
      throw err;
    }
    return homeId;
  };

  // A fabric must belong to the calling hub's home — prevents cross-home fabric access.
  const requireOwnFabric = (req: FastifyRequest, fabricId: string): string => {
    const homeId = homeOf(req);
    const fabric = matter.fabricsForHome(homeId).find((f) => f.fabricId === fabricId);
    if (!fabric) {
      const err = new Error("fabric not found for this home") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    return homeId;
  };

  app.setErrorHandler((err: Error, req, reply) => {
    const status = (err as Error & { statusCode?: number }).statusCode ?? (err instanceof MatterError ? 400 : 500);
    // Don't reflect unexpected (500) exception messages to the caller — log them, return generic.
    if (status >= 500) {
      req.log.error({ err }, "matter cloud error");
      reply.code(status).send({ code: "internal", message: "internal error" });
      return;
    }
    reply.code(status).send({ code: status === 401 ? "unauthorized" : status === 404 ? "not_found" : "error", message: err.message });
  });

  app.get("/healthz", async () => ({ status: "ok", service: "matter" }));

  // Ensure (idempotent) the home's fabric and return it.
  app.post("/v1/matter/fabrics", async (req, reply) => {
    const homeId = homeOf(req);
    const fabric = matter.ensureFabric(homeId);
    reply.code(201).send({ fabric, admins: matter.admins(fabric.fabricId) });
  });

  app.get("/v1/matter/fabrics", async (req, reply) => {
    const homeId = homeOf(req);
    reply.send({ fabrics: matter.fabricsForHome(homeId) });
  });

  // Add a co-admin (multi-admin: share the fabric with Apple Home / Google).
  app.post<{ Params: { fabricId: string }; Body: { adminNodeId?: string; label?: string } }>(
    "/v1/matter/fabrics/:fabricId/admins",
    async (req, reply) => {
      requireOwnFabric(req, req.params.fabricId);
      const { adminNodeId, label } = req.body ?? {};
      if (!adminNodeId || !label) throw badRequest("adminNodeId and label are required");
      const admin = matter.addAdmin(req.params.fabricId, adminNodeId, label);
      reply.code(201).send({ admin });
    },
  );

  app.get<{ Params: { fabricId: string } }>("/v1/matter/fabrics/:fabricId/admins", async (req, reply) => {
    requireOwnFabric(req, req.params.fabricId);
    reply.send({ admins: matter.admins(req.params.fabricId) });
  });

  // Record a node the hub commissioned locally (mirrors its operational-credential reference).
  app.post<{ Params: { fabricId: string }; Body: { nodeId?: string; vendorId?: number; productId?: number } }>(
    "/v1/matter/fabrics/:fabricId/nodes",
    async (req, reply) => {
      requireOwnFabric(req, req.params.fabricId);
      const { nodeId, vendorId, productId } = req.body ?? {};
      if (!nodeId) throw badRequest("nodeId is required");
      const node = matter.commissionNode({ fabricId: req.params.fabricId, nodeId, vendorId: vendorId ?? 0, productId: productId ?? 0 });
      reply.code(201).send({ node });
    },
  );

  app.get<{ Params: { fabricId: string } }>("/v1/matter/fabrics/:fabricId/nodes", async (req, reply) => {
    requireOwnFabric(req, req.params.fabricId);
    reply.send({ nodes: matter.nodes(req.params.fabricId) });
  });

  return app;
}

function badRequest(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}
