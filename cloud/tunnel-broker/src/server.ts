import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { TunnelBroker, type HubHandshake, type TunnelRequest } from "./broker.js";
import { verifyMobileAuthorizationToken } from "@supreme/hub-identity";

/**
 * Tunnel Broker HTTP/WS surface (ADR 0009):
 *   GET  /v1/hub/tunnel            — hub dials out (WS); challenge-response cert handshake,
 *                                    then the socket is held open for remote access.
 *   ALL  /v1/route/:hubId/*        — off-LAN client request → forwarded over the hub's tunnel.
 *
 * The hub is authenticated by its device credential (proof-of-possession). The CLIENT is
 * authenticated + authorized by `authorizeClient` — verifies the Supreme access token and that
 * the account is a member of `hubId`. Fail-closed: with no authorizer configured, client
 * routing is denied (the hub side is always cert-gated regardless).
 */
export interface TunnelBrokerServerOptions {
  /** Hub CA public key the broker trusts (verifies hub device credentials). */
  caPublicKey: string;
  /** Authorize a client request for a hub (token + membership). Returns false to deny. */
  authorizeClient?: (hubId: string, authorization: string | undefined) => Promise<boolean>;
  broker?: TunnelBroker;
  logLevel?: string;
}

export function buildTunnelBrokerServer(opts: TunnelBrokerServerOptions): FastifyInstance {
  const app = Fastify({ logger: { level: opts.logLevel ?? "info" }, bodyLimit: 2_000_000 });
  const broker = opts.broker ?? new TunnelBroker({ caPublicKey: opts.caPublicKey });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.get("/healthz", async () => ({ status: "ok", service: "tunnel-broker" }));

  // ── Hub control channel (cert-authenticated, hub-initiated) ──────────────────────────────
  app.register(async (scoped) => {
    await scoped.register(fastifyWebsocket);
    scoped.get("/v1/hub/tunnel", { websocket: true }, (socket) => {
      const ws = socket as unknown as WebSocket;
      const challenge = broker.issueChallenge();
      let detach: (() => void) | null = null;
      ws.send(JSON.stringify({ t: "challenge", nonce: challenge }));

      ws.on("message", (raw: Buffer) => {
        const text = raw.toString();
        if (!detach) {
          // First frame must be the auth handshake.
          let frame: { t?: string } & Partial<HubHandshake>;
          try {
            frame = JSON.parse(text);
          } catch {
            ws.close(1008, "bad handshake");
            return;
          }
          if (frame.t !== "auth" || !frame.credential || !frame.challengeSignature) {
            ws.close(1008, "expected auth");
            return;
          }
          const result = broker.verifyHandshake(
            { credential: frame.credential, challengeSignature: frame.challengeSignature },
            challenge,
          );
          if (!result.ok || !result.hubId) {
            ws.close(1008, "unauthorized");
            return;
          }
          detach = broker.attach(result.hubId, { send: (d) => ws.send(d) }, frame.credential.devicePublicKey);
          ws.send(JSON.stringify({ t: "ready", hubId: result.hubId }));
          (ws as unknown as { _hubId?: string })._hubId = result.hubId;
          return;
        }
        // Post-auth: response frames from the hub.
        const hubId = (ws as unknown as { _hubId?: string })._hubId;
        if (hubId) broker.handleMessage(hubId, text);
      });

      ws.on("close", () => detach?.());
    });
  });

  // Real default authorizer (§Phase12 §11): verifies a Mobile-authorization token's Ed25519
  // signature against THIS hub's own device public key — the same key `verifyHandshake`
  // above already proved possession of. No synchronous call back to the hub is needed, and
  // no second, separately-trusted keypair is introduced; the Hub remains the sole issuer
  // (`services/gateway/src/routes/pairing.ts`). Fails closed on a missing/malformed header,
  // an unknown/offline hub (no public key on file), or ANY verification failure — never a
  // default-allow. `opts.authorizeClient` (tests, or a future additional policy layer) always
  // takes precedence when supplied. Shared by both the request/response route below AND the
  // stream route (§Phase12.9) — one authorization policy, not two.
  const authorize =
    opts.authorizeClient ??
    (async (hubId: string, authorization: string | undefined): Promise<boolean> => {
      if (!authorization?.startsWith("Bearer ")) return false;
      const hubPublicKey = broker.getHubPublicKey(hubId);
      if (!hubPublicKey) return false; // unknown/offline hub — never authorized
      const token = authorization.slice("Bearer ".length);
      const payload = verifyMobileAuthorizationToken(token, hubPublicKey);
      return payload !== null && payload.hubId === hubId;
    });

  // ── Off-LAN client live stream → broker → hub tunnel → hub's own /v1/stream → back ────────
  // §Phase12.9 — the remote counterpart of `/v1/route/:hubId/*` for a persistent stream instead
  // of one-shot request/response. Same authorization as the HTTP route (a Mobile-authorization
  // bearer token, Ed25519-verified against the Hub's own device public key — never a second
  // trust root); the token is then forwarded as the local `/v1/stream?access_token=` query the
  // Hub's own gateway already expects, so the Hub re-validates it exactly as it would on the LAN.
  app.register(async (scoped) => {
    await scoped.register(fastifyWebsocket);
    scoped.get<{ Params: { hubId: string }; Querystring: { access_token?: string } }>(
      "/v1/route/:hubId/stream",
      { websocket: true },
      async (socket, req) => {
        const ws = socket as unknown as WebSocket;
        const { hubId } = req.params;
        // A WS client can't always set a custom Authorization header on the upgrade request
        // (`package:web_socket_channel`'s portable `WebSocketChannel.connect` cannot) — mirror
        // the Hub's OWN `/v1/stream?access_token=` convention as a fallback so
        // `WebSocketHubEventStream` (§Phase12.7) works unmodified against this remote route,
        // never a second stream-transport implementation for "remote."
        const authorization =
          req.headers.authorization ?? (req.query.access_token ? `Bearer ${req.query.access_token}` : undefined);
        if (!(await authorize(hubId, authorization))) {
          ws.close(1008, "not authorized for this hub");
          return;
        }
        if (!broker.isOnline(hubId)) {
          ws.close(1013, "hub offline");
          return;
        }
        const token = (authorization ?? "").slice("Bearer ".length);
        const stream = broker.openStream(hubId, `/v1/stream?access_token=${encodeURIComponent(token)}`, {
          onData: (data) => {
            if (ws.readyState === ws.OPEN) ws.send(data);
          },
          onClose: (code, reason) => ws.close(code ?? 1011, reason ?? "hub stream closed"),
        });
        if (!stream) {
          ws.close(1013, "hub offline");
          return;
        }
        ws.on("message", (raw: Buffer) => stream.send(raw.toString()));
        ws.on("close", () => stream.close());
      },
    );
  });

  // ── Off-LAN client → broker → hub tunnel → hub gateway → back ────────────────────────────
  app.all<{ Params: { hubId: string; "*": string } }>("/v1/route/:hubId/*", async (req, reply) => {
    const { hubId } = req.params;
    if (!(await authorize(hubId, req.headers.authorization))) {
      return reply.code(403).send({ code: "forbidden", message: "not authorized for this hub" });
    }
    if (!broker.isOnline(hubId)) {
      return reply.code(503).send({ code: "hub_offline", message: "hub is not reachable" });
    }
    const wildcard = req.params["*"];
    // Only the public API contract is forwardable (the hub re-checks too).
    if (wildcard !== "healthz" && !wildcard.startsWith("v1/")) {
      return reply.code(404).send({ code: "not_found" });
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string" && k !== "host" && k !== "connection") headers[k] = v;
    }
    const tunnelReq: TunnelRequest = {
      method: req.method,
      path: `/${wildcard}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`,
      headers,
      body: typeof req.body === "string" ? req.body : undefined,
    };
    try {
      const res = await broker.forward(hubId, tunnelReq);
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
