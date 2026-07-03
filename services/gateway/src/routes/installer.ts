import {
  ActivateLicenseRequest,
  BindProtocolRequest,
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
  type ProtocolBindingList,
} from "@supreme/contracts";
import type { CapabilityKind, DeviceId, DriverId, RoomId } from "@supreme/domain-model";
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

  // Unified driver registry: every driver merged with its installed state, config schema and
  // supported operations. The Driver Manager UI populates entirely from this — any current/future
  // driver appears automatically. Secrets are masked.
  app.get("/v1/drivers/registry", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send({ drivers: await i().driverRegistry() });
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
      const device = await i().commissionDevice({
        ...input,
        roomId: input.roomId as RoomId,
      });
      reply.code(201).send({ device });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── ETS group-address import (§4): KNX project → device cards ─────────────────
  app.post("/v1/commissioning/import/knx", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const body = req.body as { content?: unknown; knxproj?: unknown; password?: unknown };
      if (typeof body?.knxproj === "string" && body.knxproj.length > 0) {
        const password = typeof body.password === "string" ? body.password : undefined;
        reply.code(201).send(await i().importKnxProject(body.knxproj, password));
        return;
      }
      const content = typeof body?.content === "string" ? body.content : typeof req.body === "string" ? req.body : "";
      if (!content) throw new SupremeError("validation_failed", "provide the ETS export as `content`, or a .knxproj as base64 `knxproj`");
      reply.code(201).send(await i().importKnx(content));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Native protocol bindings (§3) ────────────────────────────────────────────
  app.post("/v1/commissioning/bind", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const input = BindProtocolRequest.parse(req.body);
      const binding = await i().bindProtocol({
        deviceId: input.deviceId as DeviceId,
        capability: input.capability as CapabilityKind,
        protocol: input.protocol,
        address: input.address,
        config: input.config,
      });
      reply.code(201).send({ binding });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/commissioning/bindings", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const body: ProtocolBindingList = { bindings: await i().listProtocolBindings() };
      reply.send(body);
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

  // Toggle Developer Mode at runtime (unlocks every SKU + feature). Blocked in production builds —
  // the developer license can never be used in production. Admin/installer/master only.
  app.post<{ Body: { enabled?: boolean } }>("/v1/license/dev-mode", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      if (ctx.config.devModeLocked) throw new SupremeError("forbidden", "Developer Mode is locked on this build (SUPREME_DEV_MODE_LOCKED)");
      await i().setDevMode(Boolean(req.body?.enabled));
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
