import {
  ActivateLicenseRequest,
  CommissionRequest,
  DiscoverRequest,
  InstallDriverRequest,
  RestoreRequest,
  RollbackDriverRequest,
  SetDriverEnabledRequest,
  SupremeError,
  type CatalogList,
  type DiagnosticsReport,
  type DiscoveryList,
  type InstalledDriverList,
  type InstalledDriverResponse,
  type LicenseStatus,
  type ProjectExport,
} from "@supreme/contracts";
import type { DriverId, RoomId } from "@supreme/domain-model";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/**
 * Installer & admin routes (§9, §14): Driver Store, discovery + commissioning,
 * diagnostics, backup/restore, project export, and licensing. Authorized as
 * `integration` admin actions (installer/admin/master via the policy engine).
 */
export function registerInstallerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const i = () => ctx.installer;

  // ── Driver Store ─────────────────────────────────────────────────────────────
  app.get("/v1/drivers/catalog", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const catalog = (await i().drivers.browse()).map((e) => ({
        manifest: e.bundle.manifest,
        status: e.bundle.status,
        signingKeyId: e.signingKeyId,
      }));
      const body: CatalogList = { catalog };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/drivers", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const body: InstalledDriverList = { drivers: await i().drivers.listInstalled() };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/drivers/install", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "create");
      const { key, version } = InstallDriverRequest.parse(req.body);
      const driver = await i().drivers.install(key, version);
      const body: InstalledDriverResponse = { driver };
      reply.code(201).send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { key: string } }>("/v1/drivers/:key/update", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      const driver = await i().drivers.update(req.params.key);
      reply.send({ driver } satisfies InstalledDriverResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { key: string } }>("/v1/drivers/:key/rollback", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      const { version } = RollbackDriverRequest.parse(req.body);
      const driver = await i().drivers.rollback(req.params.key, version);
      reply.send({ driver } satisfies InstalledDriverResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/drivers/:id/enabled", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      const { enabled } = SetDriverEnabledRequest.parse(req.body);
      const driver = await i().enableDriver(req.params.id as DriverId, enabled);
      reply.send({ driver } satisfies InstalledDriverResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/drivers/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "delete");
      await i().drivers.uninstall(req.params.id as DriverId);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Discovery & commissioning ────────────────────────────────────────────────
  app.post("/v1/commissioning/discover", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const { protocol } = DiscoverRequest.parse(req.body ?? {});
      const body: DiscoveryList = { discovered: await i().discover(protocol) };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/commissioning/commission", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const input = CommissionRequest.parse(req.body);
      const device = await i().commissioning.commission({
        ...input,
        roomId: input.roomId as RoomId,
      });
      reply.code(201).send({ device });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Diagnostics ──────────────────────────────────────────────────────────────
  app.get("/v1/diagnostics", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send((await i().diagnostics()) satisfies DiagnosticsReport);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Project export ───────────────────────────────────────────────────────────
  app.get("/v1/project/export", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send((await i().projectExport()) satisfies ProjectExport);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Backup / restore ─────────────────────────────────────────────────────────
  app.post("/v1/backup", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      reply.send(await i().createBackup());
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/backup/restore", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      const { document } = RestoreRequest.parse(req.body);
      reply.send(await i().restore(document));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Licensing ────────────────────────────────────────────────────────────────
  app.get("/v1/license", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send(i().licenseStatus() satisfies LicenseStatus);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/license/activate", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      const { token } = ActivateLicenseRequest.parse(req.body);
      await i().activateLicense(token);
      reply.send(i().licenseStatus() satisfies LicenseStatus);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Dev-only license issuance (no cloud licensing key configured).
  app.post("/v1/license/dev-issue", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      const body = (req.body ?? {}) as { sku?: string; seats?: number; features?: string[] };
      const token = i().devIssueLicense({
        sku: body.sku ?? "estate",
        seats: body.seats ?? 10,
        features: body.features ?? [],
      });
      reply.code(201).send({ token });
    } catch (err) {
      sendError(reply, err);
    }
  });
}
