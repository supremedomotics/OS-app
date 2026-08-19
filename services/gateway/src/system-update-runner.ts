import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { GatewayConfig } from "./config.js";

/**
 * § UI-triggered source-mode update — process-spawn boundary (native-linux deployment only).
 *
 * Isolated in its own module, behind three narrow, mockable functions, for two reasons:
 *  1. Every argv passed to `sudo`/`systemctl` here is a FIXED array built from server-controlled
 *     config only — nothing from an HTTP request body ever reaches these functions or is
 *     interpolated into a string. `execFile` (never `exec`/`spawn(..., {shell:true})`) means there
 *     is no shell to inject into even if that changed later.
 *  2. Tests exercise the argv-construction functions directly and can substitute `execFile`
 *     (vi.mock("node:child_process")) to assert on what WOULD have run, without ever touching a
 *     real root privilege boundary — see system-source-update.e2e.test.ts.
 *
 * § Self-restart problem: update.sh's own restart_services() step restarts supreme-gateway,
 * killing whatever process spawned it directly. Solved by never holding the update process as a
 * child of the gateway at all — trigger() launches it via `systemd-run` as an independent,
 * `--collect`ed transient unit living outside the gateway's own systemd cgroup, so it survives
 * the gateway's restart. status() re-derives EVERYTHING (running/completed/failed/phase) from the
 * unit's live systemd state + its log file on every call — nothing is held in gateway process
 * memory — so a gateway restart mid-update loses no information; the very next poll (from either
 * the old or the newly-restarted gateway process) reports the same truth.
 */

export const UPDATE_UNIT = "supreme-update";

export interface UpdateUnitStatus {
  /** systemd's own ActiveState for the transient unit, or "unknown" if the unit has never run
   * (never triggered on this boot) or systemctl could not be queried. */
  activeState: "active" | "activating" | "inactive" | "failed" | "deactivating" | "reloading" | "unknown";
  subState: string;
  /** 0 = update.sh exited 0 (success). Non-zero / "unknown" = still running or no run yet. */
  exitStatus: string;
  startedAt: string;
}

/** No sudo needed — querying a unit's own properties over the systemd D-Bus API is unprivileged
 * for any user, only STARTING one requires the sudoers grant below. */
export function queryUpdateUnitStatus(): Promise<UpdateUnitStatus> {
  return new Promise((resolve) => {
    execFile(
      "systemctl",
      ["show", UPDATE_UNIT, "--no-pager", "-p", "ActiveState", "-p", "SubState", "-p", "ExecMainStatus", "-p", "ExecMainStartTimestamp"],
      { timeout: 5_000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve({ activeState: "unknown", subState: "", exitStatus: "unknown", startedAt: "" });
          return;
        }
        const fields = Object.fromEntries(
          stdout
            .split("\n")
            .map((l) => l.split("=") as [string, string])
            .filter((p) => p.length === 2),
        );
        const active = (fields.ActiveState ?? "unknown") as UpdateUnitStatus["activeState"];
        resolve({
          activeState: active,
          subState: fields.SubState ?? "",
          exitStatus: fields.ExecMainStatus ?? "unknown",
          startedAt: fields.ExecMainStartTimestamp ?? "",
        });
      },
    );
  });
}

/** Fixed, non-parameterized argv for the ONE privileged action this endpoint may ever trigger —
 * every element here comes from `config` (server-rendered at install/update time), never from a
 * request. Matches the sudoers NOPASSWD entry infra/native-linux/lib/common.sh's
 * configure_update_sudoers() provisions byte-for-byte; changing either without the other breaks
 * the trigger with a permission error, by design (fail closed, not fail open). */
export function buildUpdateTriggerArgv(config: Pick<GatewayConfig, "updateScriptPath" | "updateLogPath">): string[] {
  const logRedirect = config.updateLogPath ? `append:${config.updateLogPath}` : "journal";
  return [
    "-n", // sudo: non-interactive — never hang the request waiting on a password prompt
    "/usr/bin/systemd-run",
    `--unit=${UPDATE_UNIT}`,
    "--collect",
    "--property=Type=oneshot",
    `--property=StandardOutput=${logRedirect}`,
    "--property=StandardError=inherit",
    "--",
    config.updateScriptPath,
  ];
}

/** Actually launches it. Fire-and-forget from the gateway's point of view — systemd-run returns
 * as soon as the transient unit is accepted, well before update.sh finishes (or before the
 * gateway that's about to be restarted by it goes down). Rejects only if `sudo systemd-run`
 * itself could not even be started/accepted (permission denied, binary missing, sudoers not
 * provisioned) — never on update.sh's own eventual success/failure, which is only knowable later
 * via queryUpdateUnitStatus()/readUpdateLogTail(). */
export function triggerUpdateUnit(config: Pick<GatewayConfig, "updateScriptPath" | "updateLogPath">): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("sudo", buildUpdateTriggerArgv(config), { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
        return;
      }
      resolve();
    });
  });
}

/** Last N lines of the log file update.sh's systemd-run invocation appends to. Read-only, best
 * effort — an unreadable/missing log (feature not provisioned, or before the first line is
 * flushed) reports an empty tail rather than throwing, since this is progress detail, not the
 * authoritative running/failed signal (queryUpdateUnitStatus() is that). */
export function readUpdateLogTail(config: Pick<GatewayConfig, "updateLogPath">, maxLines = 200): string[] {
  if (!config.updateLogPath) return [];
  try {
    const text = readFileSync(config.updateLogPath, "utf8");
    const lines = text.split("\n").filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/** update.sh's own lib/common.sh logging conventions (log_step/log_error/log_info/log_warn) —
 * parsed here, not re-derived from a hand-maintained "expected phases" list, so this never drifts
 * from what the script actually does (§ non-negotiable property 4). */
export function latestPhase(logLines: string[]): string | null {
  for (let i = logLines.length - 1; i >= 0; i--) {
    const m = /=== (.+) ===\s*$/.exec(logLines[i] ?? "");
    if (m?.[1]) return m[1];
  }
  return null;
}

export function latestError(logLines: string[]): string | null {
  for (let i = logLines.length - 1; i >= 0; i--) {
    const m = /\bERROR\s+(.+)$/.exec(logLines[i] ?? "");
    if (m?.[1]) return m[1];
  }
  return null;
}
