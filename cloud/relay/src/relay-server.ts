import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { PushDispatcher, type RelayPushPayload } from "./push-dispatcher.js";
import { TunnelRegistry, type TunnelRequest } from "./tunnel.js";

export interface RelayServerOptions {
  /** Bearer token a hub must present to register its tunnel + forward push. */
  hubAuthToken: string;
  dispatcher?: PushDispatcher;
  registry?: TunnelRegistry;
  logLevel?: string;
}

/**
 * The Supreme Cloud relay HTTP/WS surface (§8, §13):
 *   POST /v1/push                     — hub forwards a notification → platform delivery
 *   GET  /v1/tunnel?home=&token=      — hub dials out (WS), held open for remote access
 *   ALL  /v1/relay/:homeId/*          — off-LAN client request, forwarded over the tunnel
 */
export function buildRelayServer(opts: RelayServerOptions): FastifyInstance {
  const app = Fastify({ logger: { level: opts.logLevel ?? "info" }, bodyLimit: 2_000_000 });
  const dispatcher = opts.dispatcher ?? new PushDispatcher();
  const registry = opts.registry ?? new TunnelRegistry();

  // Keep the raw JSON body as a string so we can forward it verbatim over the tunnel.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  );

  const bearer = (auth: string | undefined): string =>
    auth?.startsWith("Bearer ") ? auth.slice(7) : "";

  app.get("/healthz", async () => ({ status: "ok", service: "relay" }));

  // ── Push fan-out ──────────────────────────────────────────────────────────────
  app.post("/v1/push", async (req, reply) => {
    if (bearer(req.headers.authorization) !== opts.hubAuthToken) {
      return reply.code(401).send({ code: "unauthorized" });
    }
    let payload: RelayPushPayload;
    try {
      payload = JSON.parse(req.body as string) as RelayPushPayload;
    } catch {
      return reply.code(400).send({ code: "bad_request" });
    }
    const delivered = await dispatcher.dispatch(payload).catch(() => false);
    reply.code(delivered ? 202 : 200).send({ delivered });
  });

  // ── Remote-access tunnel ───────────────────────────────────────────────────────
  app.register(async (scoped) => {
    await scoped.register(fastifyWebsocket);
    scoped.get("/v1/tunnel", { websocket: true }, (socket, req) => {
      const params = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
      const homeId = params.get("home") ?? "";
      if (!homeId || params.get("token") !== opts.hubAuthToken) {
        (socket as unknown as WebSocket).close(1008, "unauthorized");
        return;
      }
      const ws = socket as unknown as WebSocket;
      const unregister = registry.register(homeId, { send: (d) => ws.send(d) });
      ws.on("message", (raw: Buffer) => registry.handleMessage(homeId, raw.toString()));
      ws.on("close", () => unregister());
    });
  });

  // Off-LAN client → relay → hub tunnel → hub gateway → back.
  app.all<{ Params: { homeId: string; "*": string } }>("/v1/relay/:homeId/*", async (req, reply) => {
    const { homeId } = req.params;
    if (!registry.isOnline(homeId)) {
      return reply.code(503).send({ code: "hub_offline", message: "home is not reachable" });
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string" && k !== "host" && k !== "connection") headers[k] = v;
    }
    const tunnelReq: TunnelRequest = {
      method: req.method,
      path: `/${req.params["*"]}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`,
      headers,
      body: typeof req.body === "string" ? req.body : undefined,
    };
    try {
      const res = await registry.request(homeId, tunnelReq);
      reply.code(res.status);
      for (const [k, v] of Object.entries(res.headers)) {
        if (k.toLowerCase() !== "content-length") reply.header(k, v);
      }
      return res.body;
    } catch (err) {
      return reply.code(504).send({ code: "tunnel_error", message: (err as Error).message });
    }
  });

  return app;
}
