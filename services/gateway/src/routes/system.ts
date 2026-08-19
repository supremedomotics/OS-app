import { SupremeError } from "@supreme/contracts";
import type { DriverId } from "@supreme/domain-model";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

/** § PASS 22B Part A/B — reset progress, tracked in-memory only (single-process local
 * hub, ADR-local-first: nothing here needs to survive a restart — a crash mid-reset is
 * already an incomplete reset either way, and the tracker starts fresh at "idle" on the
 * next boot same as `ctx.setupRequired` does). One tracker per `AppContext`/server
 * instance (module-scoped closure, not a new store — `registerSystemRoutes` runs
 * exactly once per `AppContext`, same lifetime as `ctx` itself). */
type ResetStatus = "idle" | "resetting" | "completed" | "failed";
interface ResetState {
  status: ResetStatus;
  lastError: string | null;
  failedStep: string | null;
  updatedAt: string;
}

/**
 * System Reset (§ PASS 22 Part B, P0; hardened Pass 22B Part A/B). A real, admin-gated,
 * two-step-confirmed factory reset: uninstalls every driver (which already cascades to
 * its owned devices/bindings — see InstallerServices.uninstallDriver), sweeps any
 * devices/rooms/scenes/automations/pending-devices left over, deletes every user
 * including the master account, then flips ctx.setupRequired back to true so the app
 * re-enters first-run Setup.
 *
 * Deliberately does NOT touch: the OS, Node/NATS/Caddy/Redis processes, or the source repo —
 * this is an application-state reset, not a machine wipe.
 *
 * Failure safety (§ Part A/B): this codebase's stores are plain in-memory/JSON-backed
 * maps with no transaction support (see HomeService/IdentityService's InMemory* stores) —
 * there is no atomic snapshot to roll back to, so a mid-reset failure can't be undone.
 * The correct behavior given that constraint (Option C, not a fabricated rollback) is to
 * keep going through the remaining idempotent cleanup steps — each one (uninstall driver,
 * sweep devices, remove rooms, remove scenes/automations, reset users) already tolerates
 * running again on partially-cleaned state — and land in a deterministic `failed` state
 * with exactly which step and driver failed, rather than a bare 500 that claims nothing
 * happened while silently leaving partial damage.
 */
export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const reset: ResetState = { status: "idle", lastError: null, failedStep: null, updatedAt: new Date().toISOString() };
  const setReset = (patch: Partial<ResetState>) => Object.assign(reset, patch, { updatedAt: new Date().toISOString() });
  /** Lets the confirmation dialog show real counts instead of vague "everything" language. */
  app.get("/v1/system/reset-info", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      const [users, devices, rooms, drivers] = await Promise.all([
        ctx.identity.listUsers(),
        ctx.home.listDevices(),
        ctx.home.listRooms(),
        ctx.installer.drivers.registry(),
      ]);
      reply.send({
        users: users.length,
        devices: devices.length,
        rooms: rooms.length,
        installedDrivers: drivers.filter((d) => d.installed).length,
      });
    } catch (err) {
      sendError(reply, err);
    }
  });

  /** Lets a client (or a test) observe the reset state machine directly instead of only
   * inferring it from a prior POST's response — e.g. after firing a second concurrent
   * request, or confirming the tracker returned to "idle"/"completed" (never stuck) after
   * a failure. */
  app.get("/v1/system/reset-status", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      reply.send(reset);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/system/reset", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Two-step confirmation: the client must echo back the literal phrase, not just a boolean,
      // so a stray double-click or scripted retry can't trigger a real reset by accident.
      if (String(body.confirm ?? "") !== "RESET SYSTEM") {
        throw new SupremeError("validation_failed", 'type "RESET SYSTEM" to confirm');
      }
      // Deterministic concurrency guard: a second reset while one is already running gets
      // a clear 409, never a silent race between two loops mutating the same stores.
      if (reset.status === "resetting") {
        throw new SupremeError("conflict", "a system reset is already in progress");
      }

      setReset({ status: "resetting", lastError: null, failedStep: null });
      const driversUninstalled: string[] = [];
      const driversFailed: { key: string; error: string }[] = [];
      let usersRemoved = 0;
      let step = "drivers";
      try {
        const drivers = await ctx.installer.drivers.registry();
        for (const d of drivers.filter((e) => e.installed && e.installedId)) {
          try {
            await ctx.installer.uninstallDriver(d.installedId as DriverId);
            driversUninstalled.push(d.key);
          } catch (err) {
            // Option C (no rollback the store layer can't support — see this file's own
            // doc comment): record which driver failed and keep going through the
            // remaining, independently-idempotent cleanup steps rather than aborting
            // with everything else half-done.
            driversFailed.push({ key: d.key, error: err instanceof Error ? err.message : String(err) });
          }
        }

        step = "devices_rooms";
        // Anything left over (manually-created devices, demo seed data, and any device a
        // failed driver above didn't get to clean up itself).
        const remainingDevices = await ctx.home.listDevices();
        if (remainingDevices.length) await ctx.home.removeDevices(remainingDevices.map((dv) => dv.id));
        for (const room of await ctx.home.listRooms()) await ctx.home.removeRoom(room.id);

        // § Part C resource inventory — scenes and automations are their OWN persistent
        // stores (ISceneStore/IAutomationStore), never cascade-deleted by a device/room
        // disappearing, so a reset that only swept devices/rooms silently left every
        // scene and automation behind for the next "fresh setup" to inherit.
        step = "scenes";
        for (const scene of await ctx.scenes.list()) await ctx.scenes.remove(scene.id);
        step = "automations";
        for (const automation of await ctx.automations.list()) await ctx.automations.remove(automation.id);
        // Pending (not-yet-approved) devices are also their own persistent store (Postgres-
        // backed only — a no-op in-memory/dev), independent of the Device Registry.
        step = "pending_devices";
        for (const pending of await ctx.installer.listPendingDevices()) {
          await ctx.installer.removePendingDevice(pending.id);
        }

        step = "users";
        usersRemoved = await ctx.identity.resetAllUsers();
        ctx.setupRequired = true;
      } catch (err) {
        setReset({ status: "failed", lastError: err instanceof Error ? err.message : String(err), failedStep: step });
        reply.code(500).send({
          ok: false,
          failedStep: step,
          error: err instanceof Error ? err.message : String(err),
          driversUninstalled,
          driversFailed,
          usersRemoved,
        });
        return;
      }

      if (driversFailed.length) {
        setReset({ status: "failed", lastError: `${driversFailed.length} driver(s) failed to uninstall`, failedStep: "drivers" });
        reply.code(207).send({ ok: false, partial: true, driversUninstalled, driversFailed, usersRemoved });
        return;
      }

      setReset({ status: "completed", lastError: null, failedStep: null });
      reply.send({ ok: true, driversUninstalled: driversUninstalled.length, usersRemoved });
    } catch (err) {
      // Confirmation/auth failures never touched `reset` at all — leave it exactly as it was.
      sendError(reply, err);
    } finally {
      // Never leave the tracker stuck in "resetting" — a thrown/unexpected error above is
      // caught (and already re-classified into "failed") before this runs; this only
      // guards the rejection path (validation/auth) which never entered "resetting".
      if (reset.status === "resetting") setReset({ status: "failed", lastError: "reset ended unexpectedly", failedStep: reset.failedStep ?? "unknown" });
    }
  });
}
