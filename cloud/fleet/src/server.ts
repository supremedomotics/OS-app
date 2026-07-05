import {
  FleetHeartbeatRequest,
  RegisterHubRequest,
  type FleetHub,
  type FleetHubList,
  type FleetHubResponse,
} from "@supreme/contracts";
import type { HomeId } from "@supreme/domain-model";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { FleetService, type FleetOptions } from "./index.js";

/**
 * Cloud fleet HTTP API (§13, §16) — OPTIONAL installer fleet management. Multi-tenant
 * by org: an API key maps to an installer org. Hubs self-register and heartbeat with
 * their org key; installers list their org's hubs with the same key. The hub never
 * depends on this for in-home function.
 */
export interface FleetServerOptions extends FleetOptions {
  /** API key → org id. In production these are issued per installer org. */
  apiKeys: Map<string, string>;
  logLevel?: string;
}

export function buildFleetServer(opts: FleetServerOptions): FastifyInstance {
  const app = Fastify({ logger: { level: opts.logLevel ?? "info" } });
  const fleet = new FleetService(opts);

  const orgOf = (req: FastifyRequest): string => {
    const header = req.headers.authorization;
    const key = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const orgId = opts.apiKeys.get(key);
    if (!orgId) {
      const err = new Error("invalid fleet API key") as Error & { statusCode: number };
      err.statusCode = 401;
      throw err;
    }
    return orgId;
  };

  app.setErrorHandler((err: Error, _req, reply) => {
    const status = (err as Error & { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ code: status === 401 ? "unauthorized" : "internal", message: err.message });
  });

  app.get("/healthz", async () => ({ status: "ok", service: "fleet" }));

  app.post("/v1/fleet/hubs", async (req, reply) => {
    const orgId = orgOf(req);
    const body = RegisterHubRequest.parse(req.body);
    const hub = await fleet.register({ orgId, homeId: body.homeId as HomeId, name: body.name, version: body.version });
    reply.code(201).send({ hub } satisfies FleetHubResponse);
  });

  app.post<{ Params: { id: string } }>("/v1/fleet/hubs/:id/heartbeat", async (req, reply) => {
    orgOf(req);
    const body = FleetHeartbeatRequest.parse(req.body ?? {});
    const hub = await fleet.heartbeat(req.params.id, body.version);
    reply.send({ hub } satisfies FleetHubResponse);
  });

  app.get("/v1/fleet/hubs", async (req, reply) => {
    const orgId = orgOf(req);
    const hubs = (await fleet.listForOrg(orgId)) as FleetHub[];
    reply.send({ hubs } satisfies FleetHubList);
  });

  return app;
}
