import { generateKeyPairSync } from "node:crypto";
import { AuthnError, AuthnService, type IssuedTokens } from "@supreme/cloud-authn";
import { DeviceError, DeviceRegistry, type Platform } from "@supreme/device-registry";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { IdentityError, IdentityService, type IdentityKind } from "./index.js";

/**
 * Identity-plane HTTP API (blueprint §5, §13) — composes Identity + AuthN + Device Registry
 * into the single off-LAN surface the Supreme app talks to:
 *
 *   GET  /v1/auth/jwks                — public keys to verify access tokens
 *   POST /v1/accounts                 — register an account (identity + password)
 *   POST /v1/auth/login               — verify credentials → register device → issue tokens
 *   POST /v1/auth/refresh             — rotate the refresh token (reuse-detection)
 *   POST /v1/auth/logout              — revoke the current session
 *   GET  /v1/devices                  — list this account's devices
 *   PATCH/DELETE /v1/devices/:id      — rename / remove a device
 *   POST /v1/devices/:id/logout       — remote-logout another device
 *
 * Auth: endpoints under /v1/devices and logout require a valid access token (Bearer). The hub
 * never appears here — this is purely the Supreme cloud identity plane.
 */
export interface IdentityServerOptions {
  identity?: IdentityService;
  authn?: AuthnService;
  devices?: DeviceRegistry;
  logLevel?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function buildIdentityServer(opts: IdentityServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: { level: opts.logLevel ?? "info" }, bodyLimit: 256_000 });
  const identity = opts.identity ?? new IdentityService();
  let authn = opts.authn;
  if (!authn) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    authn = new AuthnService({ publicKey, privateKey });
  }
  // Device deletion / remote logout revokes the auth session through AuthN.
  const devices = opts.devices ?? new DeviceRegistry({ revokeSession: (sid) => authn!.revokeSession(sid) });

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof HttpError) return void reply.code(err.status).send({ code: err.code, message: err.message });
    if (err instanceof IdentityError) {
      const status = err.code === "conflict" ? 409 : err.code === "not_found" ? 404 : 401;
      return void reply.code(status).send({ code: err.code, message: err.message });
    }
    if (err instanceof AuthnError) return void reply.code(401).send({ code: err.code, message: err.message });
    if (err instanceof DeviceError) {
      return void reply.code(err.code === "forbidden" ? 403 : 404).send({ code: err.code, message: err.message });
    }
    reply.code(500).send({ code: "internal", message: err.message });
  });

  const auth = async (req: FastifyRequest): Promise<{ accountId: string; sessionId: string }> => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    try {
      const claims = await authn!.verifyAccess(token);
      return { accountId: claims.sub, sessionId: claims.sid };
    } catch {
      throw new HttpError(401, "unauthorized", "missing or invalid access token");
    }
  };

  app.get("/healthz", async () => ({ status: "ok", service: "identity" }));
  app.get("/v1/auth/jwks", async () => authn!.jwks());

  app.post("/v1/accounts", async (req, reply) => {
    const b = (req.body ?? {}) as { kind?: IdentityKind; value?: string; password?: string };
    if (!b.kind || !b.value) throw new HttpError(422, "validation_failed", "kind and value are required");
    const { account } = await identity.register({ kind: b.kind, value: b.value, password: b.password });
    reply.code(201).send({ accountId: account.id });
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const b = (req.body ?? {}) as {
      kind?: IdentityKind;
      value?: string;
      password?: string;
      device?: { name?: string; platform?: Platform; osVersion?: string; model?: string; pushToken?: string };
    };
    if (!b.kind || !b.value || !b.password) throw new HttpError(422, "validation_failed", "credentials required");
    const accountId = await identity.verifyPassword(b.kind, b.value, b.password);

    const device = await devices.register({
      accountId,
      name: b.device?.name ?? "New device",
      platform: b.device?.platform ?? "web",
      osVersion: b.device?.osVersion,
      model: b.device?.model,
      pushToken: b.device?.pushToken,
      ip: req.ip,
    });
    const tokens: IssuedTokens = await authn!.startSession({
      accountId,
      deviceId: device.id,
      amr: ["pwd"],
    });
    await devices.attachSession(accountId, device.id, tokens.sessionId);
    reply.code(201).send({ ...tokens, device });
  });

  app.post("/v1/auth/refresh", async (req, reply) => {
    const b = (req.body ?? {}) as { refreshToken?: string };
    if (!b.refreshToken) throw new HttpError(422, "validation_failed", "refreshToken required");
    reply.send(await authn!.refresh({ refreshToken: b.refreshToken }));
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const { sessionId } = await auth(req);
    await authn!.revokeSession(sessionId);
    reply.code(204).send();
  });

  app.get("/v1/devices", async (req, reply) => {
    const { accountId } = await auth(req);
    reply.send({ devices: await devices.list(accountId) });
  });

  app.patch<{ Params: { id: string } }>("/v1/devices/:id", async (req, reply) => {
    const { accountId } = await auth(req);
    const b = (req.body ?? {}) as { name?: string };
    if (!b.name) throw new HttpError(422, "validation_failed", "name required");
    reply.send(await devices.rename(accountId, req.params.id, b.name));
  });

  app.delete<{ Params: { id: string } }>("/v1/devices/:id", async (req, reply) => {
    const { accountId } = await auth(req);
    await devices.remove(accountId, req.params.id);
    reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/devices/:id/logout", async (req, reply) => {
    const { accountId } = await auth(req);
    reply.send(await devices.remoteLogout(accountId, req.params.id));
  });

  return app;
}
