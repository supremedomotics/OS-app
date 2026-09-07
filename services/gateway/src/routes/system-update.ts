import type { FastifyInstance } from "fastify";
import { SupremeError } from "@supreme/contracts";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";
import { latestError, latestPhase, queryUpdateUnitStatus, readUpdateLogTail, triggerUpdateUnit } from "../system-update-runner.js";

/**
 * Source-mode "Update now" (§ native-linux deployment, Settings > Software update). Lets an
 * admin/master trigger infra/native-linux/update.sh from the web UI instead of SSHing in — a
 * DIFFERENT concern from /v1/system/update (§ Update Center) above, which only checks a signed
 * OTA-artifact channel and never touches this git-checkout-and-build path. Deliberately reuses
 * update.sh as-is (backup → build → verify → atomic switch → restart → health-check → auto-
 * rollback already lives there, fixed and tested) — this route never reimplements any of that
 * logic, it only launches the script and reports back what it's doing.
 *
 * Status is intentionally NOT held in gateway process memory (contrast System Reset's in-memory
 * `ResetState` in routes/system.ts, which is fine there because that operation can't restart the
 * process reporting on it) — update.sh's own restart_services() step restarts supreme-gateway
 * partway through a real run, which would kill any in-memory tracker along with the process. Every
 * status read instead re-derives truth from the systemd transient unit + its log file (see
 * system-update-runner.ts's own header comment), so a gateway restart mid-update loses nothing:
 * the very next poll — old process or newly-restarted one, doesn't matter — reports the same facts.
 */
export function registerSystemUpdateRoutes(app: FastifyInstance, ctx: AppContext): void {
  const configured = () => Boolean(ctx.config.updateScriptPath);

  /** Derives idle|running|completed|failed purely from systemd + the log tail — never guessed,
   * never cached. `phase` is update.sh's own most recent `log_step` line (real progress, not a
   * fabricated percentage — § non-negotiable property 4). */
  async function currentStatus() {
    if (!configured()) {
      return { enabled: false as const, status: "unavailable" as const };
    }
    const unit = await queryUpdateUnitStatus();
    const log = readUpdateLogTail(ctx.config);
    const phase = latestPhase(log);
    const error = latestError(log);

    let status: "idle" | "running" | "completed" | "failed";
    if (unit.activeState === "active" || unit.activeState === "activating" || unit.activeState === "reloading") {
      status = "running";
    } else if (unit.activeState === "unknown" || unit.activeState === "inactive") {
      // "inactive" with no ExecMainStartTimestamp means the unit has never run this boot (or was
      // never triggered) — same as "unknown". Only a unit that HAS run and is now inactive/failed
      // with a real timestamp reports a completed/failed outcome below.
      status = unit.startedAt ? (unit.exitStatus === "0" ? "completed" : "failed") : "idle";
    } else {
      // "failed"/"deactivating" from systemd's own ActiveState.
      status = unit.exitStatus === "0" ? "completed" : "failed";
    }
    return { enabled: true as const, status, phase, error: status === "failed" ? error : null, startedAt: unit.startedAt || null, logTail: log.slice(-40) };
  }

  app.get("/v1/system/source-update/status", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send(await currentStatus());
    } catch (err) {
      sendError(reply, err);
    }
  });

  // POST-only (§ non-negotiable property 5) — a bare/CSRF-able GET can never trigger this.
  app.post("/v1/system/source-update/trigger", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      // § non-negotiable property 1 — same admin-gate System Reset uses (routes/system.ts).
      await enforce(ctx, user, "integration", null, "admin");

      if (!configured()) {
        throw new SupremeError("not_found", "Source-mode update is not available on this deployment (SUPREME_UPDATE_SCRIPT not configured).");
      }

      // § non-negotiable property 3/6 — refuse a second concurrent trigger. This catches every
      // UI-triggered run (the unit's own ActiveState is authoritative for those); a run started
      // independently via SSH is caught by update.sh's own flock instead (see update.sh's main())
      // — this pre-check can't see that one, so the honest fallback is: the trigger below still
      // "succeeds" (systemd-run accepts a new unit), but that instance of update.sh exits
      // immediately with "already running", which the very next status poll surfaces as `failed`
      // with that exact reason — never a silently-lost second run pretending to have worked.
      const before = await currentStatus();
      if (before.status === "running") {
        throw new SupremeError("conflict", "An update is already running.");
      }

      await triggerUpdateUnit(ctx.config);
      reply.send({ ok: true, triggeredAt: new Date().toISOString() });
    } catch (err) {
      sendError(reply, err);
    }
  });
}
