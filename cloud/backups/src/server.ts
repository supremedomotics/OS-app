import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { BackupVaultError, BackupVaultService, type BackupVaultOptions } from "./index.js";

/**
 * Off-site backup vault HTTP API (blueprint §13) — OPTIONAL. Per-hub API keys map to a homeId, so a
 * hub can only read/write its own home's backups. The body is the hub's already-encrypted ciphertext
 * (base64); the vault is zero-knowledge.
 */
export interface BackupServerOptions extends BackupVaultOptions {
  /** Per-hub API key → homeId (issued at enrollment). */
  apiKeys: Map<string, string>;
  /** Max upload size in bytes (default 64 MB). */
  maxUploadBytes?: number;
  logLevel?: string;
}

export function buildBackupServer(opts: BackupServerOptions): FastifyInstance {
  const app = Fastify({ logger: { level: opts.logLevel ?? "info" }, bodyLimit: opts.maxUploadBytes ?? 64 * 1024 * 1024 });
  const vault = new BackupVaultService(opts);

  const homeOf = (req: FastifyRequest): string => {
    const header = req.headers.authorization;
    const key = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const homeId = opts.apiKeys.get(key);
    if (!homeId) {
      const err = new Error("invalid backup API key") as Error & { statusCode: number };
      err.statusCode = 401;
      throw err;
    }
    return homeId;
  };

  app.setErrorHandler((err: Error, req, reply) => {
    const status = (err as Error & { statusCode?: number }).statusCode ?? (err instanceof BackupVaultError ? 400 : 500);
    if (status >= 500) {
      req.log.error({ err }, "backup vault error");
      reply.code(status).send({ code: "internal", message: "internal error" });
      return;
    }
    reply.code(status).send({ code: status === 401 ? "unauthorized" : status === 404 ? "not_found" : "error", message: err.message });
  });

  app.get("/healthz", async () => ({ status: "ok", service: "backups" }));

  // Upload an encrypted backup. Body: { createdAt?, schemaVersion?, sha256?, ciphertext (base64) }.
  app.post<{ Body: { createdAt?: string; schemaVersion?: string; sha256?: string; ciphertext?: string } }>(
    "/v1/backups",
    async (req, reply) => {
      const homeId = homeOf(req);
      const b = req.body ?? {};
      if (!b.ciphertext) throw badRequest("ciphertext (base64) is required");
      const ciphertext = Buffer.from(b.ciphertext, "base64");
      const record = await vault.store({
        homeId,
        createdAt: b.createdAt,
        schemaVersion: b.schemaVersion,
        ciphertext,
        ...(b.sha256 ? { expectedSha256: b.sha256 } : {}),
      });
      reply.code(201).send({ backup: record });
    },
  );

  app.get("/v1/backups", async (req, reply) => {
    const homeId = homeOf(req);
    reply.send({ backups: vault.list(homeId) });
  });

  app.get<{ Params: { id: string } }>("/v1/backups/:id", async (req, reply) => {
    const homeId = homeOf(req);
    const { record, ciphertext } = await vault.fetch(homeId, req.params.id);
    reply.send({ backup: record, ciphertext: ciphertext.toString("base64") });
  });

  app.delete<{ Params: { id: string } }>("/v1/backups/:id", async (req, reply) => {
    const homeId = homeOf(req);
    await vault.remove(homeId, req.params.id);
    reply.code(204).send();
  });

  return app;
}

function badRequest(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}
