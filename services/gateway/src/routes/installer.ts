import {
  ActivateLicenseRequest,
  BindProtocolRequest,
  CommissionRequest,
  DiscoverRequest,
  InstallDriverRequest,
  ApproveDeviceRequest,
  BackupScheduleInput,
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
  type SystemUpdate,
  type BackupList,
  type BackupStatus,
  type BackupScheduleResponse,
  type PendingDeviceList,
} from "@supreme/contracts";
import type { CapabilityKind, DeviceId, DriverId, RoomId } from "@supreme/domain-model";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";
import { collectSystemHealth } from "../system-health.js";
import { OtaChecker } from "../ota.js";

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

  // Driver Diagnostics (§ Diagnostics): full Driver Lifecycle picture for every driver —
  // registration stage, protocol status, ownership/binding counts, health, last error,
  // reconnect history — without reading logs.
  app.get("/v1/drivers/diagnostics", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send({ drivers: await i().driverDiagnostics(), ownership: ctx.sil.ownership.countsByKind() });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Per-driver configuration (schema + masked values), and a schema-validated update.
  app.get<{ Params: { id: string } }>("/v1/drivers/:id/config", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send(await i().getDriverConfig(req.params.id as DriverId));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: { config?: Record<string, unknown> } }>("/v1/drivers/:id/config", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      reply.send(await i().setDriverConfig(req.params.id as DriverId, req.body?.config ?? {}));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/drivers/install", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "create");
      const { key, version } = InstallDriverRequest.parse(req.body);
      const driver = await i().installDriver(key, version);
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
      await i().uninstallDriver(req.params.id as DriverId);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Per-driver health, logs, and connect/disconnect (Driver Manager operations).
  app.get<{ Params: { id: string } }>("/v1/drivers/:id/health", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send(await i().driverHealth(req.params.id as DriverId));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/v1/drivers/:id/logs", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send(await i().driverLogs(req.params.id as DriverId));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Settings → Logs (§ Diagnostics): every driver install/enable/connect/native-connection
  // event plus device control operation outcomes, in one unified stream — not scattered
  // across each Extension Center card.
  app.get<{ Querystring: { limit?: string } }>("/v1/system/logs", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : undefined;
      reply.send({ entries: i().systemLogs(Number.isFinite(limit) ? limit : undefined) });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/drivers/:id/connect", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      reply.send(await i().connectDriver(req.params.id as DriverId));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/drivers/:id/disconnect", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      reply.send(await i().disconnectDriver(req.params.id as DriverId));
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

  // ── Device Approval (§ Device Approval): scan → pending queue → approve/reject ─────
  app.post("/v1/commissioning/scan", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const { protocol } = DiscoverRequest.parse(req.body ?? {});
      reply.send({ pending: await i().scanForApproval(protocol) } satisfies PendingDeviceList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/devices/pending", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "view");
      reply.send({ pending: await i().listPendingDevices() } satisfies PendingDeviceList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/devices/pending/:id/approve", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const input = ApproveDeviceRequest.parse(req.body);
      const device = await i().approvePendingDevice(req.params.id, { ...input, roomId: input.roomId as RoomId });
      reply.code(201).send({ device });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/devices/pending/:id/reject", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      await i().rejectPendingDevice(req.params.id);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/devices/pending/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      await i().removePendingDevice(req.params.id);
      reply.code(204).send();
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

  // Parse-only preview: same inputs as the import route, but nothing is committed — the
  // installer reviews the device list (room, detected circuit type) before saving.
  app.post("/v1/commissioning/import/knx/preview", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const body = req.body as { content?: unknown; knxproj?: unknown; password?: unknown };
      if (typeof body?.knxproj === "string" && body.knxproj.length > 0) {
        const password = typeof body.password === "string" ? body.password : undefined;
        reply.send(await i().previewKnxProject(body.knxproj, password));
        return;
      }
      const content = typeof body?.content === "string" ? body.content : typeof req.body === "string" ? req.body : "";
      if (!content) throw new SupremeError("validation_failed", "provide the ETS export as `content`, or a .knxproj as base64 `knxproj`");
      reply.send(await i().previewKnx(content));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Save a (possibly edited) preview: commissions every included device, no re-parsing.
  app.post("/v1/commissioning/import/knx/commit", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const body = req.body as { devices?: unknown };
      if (!Array.isArray(body?.devices)) throw new SupremeError("validation_failed", "provide `devices` (the reviewed preview list)");
      reply.code(201).send(await i().commitKnxImport(body.devices));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Auto-commission a live native bus (e.g. Casambi): discover → create rooms from the bus's
  // group names → commission + bind every device in one step.
  app.post("/v1/commissioning/auto", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const protocol = (req.body as { protocol?: unknown })?.protocol;
      if (typeof protocol !== "string" || !protocol) {
        throw new SupremeError("validation_failed", "provide the native `protocol` to auto-commission");
      }
      reply.code(201).send(await i().autoCommission(protocol));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // KNXnet/IP interface discovery — find gateways on the LAN to configure the KNX driver host/port.
  app.get("/v1/commissioning/knx/interfaces", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      reply.send({ interfaces: await i().discoverKnxInterfaces() });
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

  // Real host telemetry (§ Installer Dashboard): CPU / memory / temperature / storage / uptime read
  // straight from the OS. Metrics with no source on this platform are omitted, never faked.
  app.get("/v1/system/health", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send(await collectSystemHealth());
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Software-update status (§ Update Center). Checks the signed OTA channel if one is configured;
  // otherwise honestly reports the current version with channelConfigured=false. Detection only —
  // the OS updater applies verified releases (staged + rollback-safe).
  app.get("/v1/system/update", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const cfg = ctx.config;
      const checkedAt = new Date().toISOString();
      if (!cfg.otaUrl || !cfg.otaPublicKey) {
        reply.send({ current: cfg.hubVersion, channelConfigured: false, updateAvailable: false, checkedAt } satisfies SystemUpdate);
        return;
      }
      try {
        const result = await new OtaChecker({ url: cfg.otaUrl, publicKeyPem: cfg.otaPublicKey, currentVersion: cfg.hubVersion }).check();
        reply.send({
          current: result.current,
          channelConfigured: true,
          updateAvailable: result.updateAvailable,
          ...(result.latest ? { latest: { version: result.latest.version, notes: result.latest.notes, releasedAt: result.latest.releasedAt } } : {}),
          checkedAt,
        } satisfies SystemUpdate);
      } catch (e) {
        reply.send({ current: cfg.hubVersion, channelConfigured: true, updateAvailable: false, checkedAt, error: e instanceof Error ? e.message : "update check failed" } satisfies SystemUpdate);
      }
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
      const { document, dryRun } = RestoreRequest.parse(req.body);
      // Dry-run previews what would be restored (and verifies the signature) without touching data.
      if (dryRun) {
        reply.send({ inspection: i().inspectRestore(document) });
        return;
      }
      reply.send(await i().restore(document));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Backup history (metadata only) + re-download by id.
  app.get("/v1/backup/list", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      reply.send({ backups: await i().listBackups() } satisfies BackupList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/v1/backup/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      reply.send(await i().getBackupDocument(req.params.id));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Backup health indicator: last backup, next due, retention, last restore.
  app.get("/v1/backup/status", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send((await i().backupStatus()) satisfies BackupStatus);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Backup schedule (automatic backups on the hub tick).
  app.get("/v1/backup/schedule", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send({ schedule: await i().getBackupSchedule() } satisfies BackupScheduleResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put("/v1/backup/schedule", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      const input = BackupScheduleInput.parse(req.body);
      reply.send({ schedule: await i().setBackupSchedule(input) } satisfies BackupScheduleResponse);
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
