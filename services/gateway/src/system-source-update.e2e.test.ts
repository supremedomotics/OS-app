import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * § UI-triggered source-mode update (Settings > "Apply latest committed update"). Verifies the
 * gateway route's own contract, not real root privilege escalation — this environment cannot (and
 * must not attempt to) exercise a real `sudo systemd-run`. The process-spawn boundary
 * (system-update-runner.ts's execFile calls) is mocked; everything downstream of it (auth gate,
 * POST-only, concurrency guard, status derivation, argv construction) is exercised for real
 * against a real running gateway instance, matching system-reset.e2e.test.ts's own style for the
 * closest existing precedent (a privileged, job-tracked, admin-gated action).
 */

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;
const execFileMock = vi.fn(
  (cmd: string, args: string[], _opts: unknown, cb: ExecFileCb) => {
    if (cmd === "systemctl") {
      cb(null, systemctlShowResponse, "");
      return;
    }
    if (cmd === "sudo") {
      if (triggerShouldFail) {
        cb(new Error("sudo: a password is required"), "", "sudo: a password is required");
      } else {
        cb(null, "", "");
      }
      return;
    }
    cb(new Error(`unexpected command in test: ${cmd} ${args.join(" ")}`), "", "");
  },
);
vi.mock("node:child_process", () => ({ execFile: (...a: unknown[]) => (execFileMock as unknown as (...a: unknown[]) => void)(...a) }));

// Mutable per-test fixtures the mocked execFile/readFileSync above read from.
let systemctlShowResponse = "ActiveState=inactive\nSubState=dead\nExecMainStatus=\nExecMainStartTimestamp=\n";
let triggerShouldFail = false;

const { loadConfig } = await import("./config.js");
const { AppContext } = await import("./context.js");
const { buildServer } = await import("./server.js");
const { buildUpdateTriggerArgv, latestError, latestPhase, UPDATE_UNIT } = await import("./system-update-runner.js");

describe("system-update-runner — argv construction (unit, no process spawned)", () => {
  it("builds a fixed, non-parameterized argv — nothing request-controlled can reach it", () => {
    const argv = buildUpdateTriggerArgv({ updateScriptPath: "/opt/supreme/repo/infra/native-linux/update.sh", updateLogPath: "/var/lib/supremeos/update.log" });
    expect(argv).toEqual([
      "-n",
      "/usr/bin/systemd-run",
      `--unit=${UPDATE_UNIT}`,
      "--collect",
      "--property=Type=oneshot",
      "--property=StandardOutput=append:/var/lib/supremeos/update.log",
      "--property=StandardError=inherit",
      "--",
      "/opt/supreme/repo/infra/native-linux/update.sh",
    ]);
    // Every element is a config-derived literal — none is a template string built from
    // anything an HTTP request could influence (there is no request object in scope at all).
    expect(argv.join(" ")).not.toMatch(/[;&|`$(){}<>]/);
  });

  it("latestPhase/latestError parse update.sh's own lib/common.sh log conventions", () => {
    const log = [
      "[2026-08-19T00:00:00Z] === Taking a pre-update backup ===",
      "[2026-08-19T00:00:05Z] INFO  Pre-update backup: /var/backups/x.tar.gz",
      "[2026-08-19T00:00:06Z] === Building the complete SupremeOS workspace (source mode) ===",
    ];
    expect(latestPhase(log)).toBe("Building the complete SupremeOS workspace (source mode)");
    expect(latestError(log)).toBeNull();
    expect(latestError([...log, "[2026-08-19T00:01:00Z] ERROR Regenerated Caddyfile failed validation"])).toBe(
      "Regenerated Caddyfile failed validation",
    );
  });
});

describe("POST /v1/system/source-update/trigger + GET .../status", () => {
  let app: FastifyInstance;
  let ctx: InstanceType<typeof AppContext>;
  let baseUrl: string;
  let adminToken = "";
  let logDir: string;
  let logPath: string;

  beforeAll(async () => {
    logDir = mkdtempSync(join(tmpdir(), "supreme-update-log-"));
    logPath = join(logDir, "update.log");
    writeFileSync(logPath, "");
    ctx = await AppContext.create(
      loadConfig({
        SUPREME_PORT: "0",
        SUPREME_LOG_LEVEL: "silent",
        SUPREME_UPDATE_SCRIPT: "/opt/supreme/repo/infra/native-linux/update.sh",
        SUPREME_UPDATE_LOG: logPath,
      }),
    );
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }) })
    ).json()) as { accessToken: string };
    adminToken = login.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
    rmSync(logDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    systemctlShowResponse = "ActiveState=inactive\nSubState=dead\nExecMainStatus=\nExecMainStartTimestamp=\n";
    triggerShouldFail = false;
    writeFileSync(logPath, "");
    execFileMock.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  const auth = () => ({ authorization: `Bearer ${adminToken}`, "content-type": "application/json" });

  it("rejects an unauthenticated trigger", async () => {
    const res = await fetch(`${baseUrl}/v1/system/source-update/trigger`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rejects a non-admin (guest) trigger — admin-only access enforced (§ non-negotiable property 1)", async () => {
    const guest = await ctx.identity.createUser({ homeId: ctx.homeId, email: "guest-update-test@example.com", password: "guest-password-123", displayName: "Guest", userType: "guest", expiresAt: null });
    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: guest.email, password: "guest-password-123" }) })
    ).json()) as { accessToken: string };
    const res = await fetch(`${baseUrl}/v1/system/source-update/trigger`, { method: "POST", headers: { authorization: `Bearer ${login.accessToken}`, "content-type": "application/json" } });
    expect(res.status).toBe(403);
    expect(execFileMock.mock.calls.some((c) => c[0] === "sudo")).toBe(false);
  });

  it("is not reachable via GET (POST-only, § non-negotiable property 5)", async () => {
    const res = await fetch(`${baseUrl}/v1/system/source-update/trigger`, { headers: auth() });
    expect(res.status).toBe(404); // no GET handler registered for this path at all
  });

  it("reports idle when the unit has never run", async () => {
    const res = await fetch(`${baseUrl}/v1/system/source-update/status`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ enabled: true, status: "idle" });
  });

  it("admin can trigger; the exact fixed argv is what would have been invoked", async () => {
    const res = await fetch(`${baseUrl}/v1/system/source-update/trigger`, { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; triggeredAt: string };
    expect(body.ok).toBe(true);

    const sudoCall = execFileMock.mock.calls.find((c) => c[0] === "sudo");
    expect(sudoCall).toBeTruthy();
    expect(sudoCall![1]).toEqual([
      "-n",
      "/usr/bin/systemd-run",
      `--unit=${UPDATE_UNIT}`,
      "--collect",
      "--property=Type=oneshot",
      `--property=StandardOutput=append:${logPath}`,
      "--property=StandardError=inherit",
      "--",
      "/opt/supreme/repo/infra/native-linux/update.sh",
    ]);
  });

  it("refuses a second concurrent trigger while one is running (409)", async () => {
    systemctlShowResponse = "ActiveState=active\nSubState=running\nExecMainStatus=\nExecMainStartTimestamp=Wed 2026-08-19 00:00:00 UTC\n";
    const res = await fetch(`${baseUrl}/v1/system/source-update/trigger`, { method: "POST", headers: auth() });
    expect(res.status).toBe(409);
    // Never even attempted to spawn a second `sudo systemd-run`.
    expect(execFileMock.mock.calls.some((c) => c[0] === "sudo")).toBe(false);
  });

  it("status transitions running -> completed and is correctly reported on a later poll", async () => {
    systemctlShowResponse = "ActiveState=active\nSubState=running\nExecMainStatus=\nExecMainStartTimestamp=Wed 2026-08-19 00:00:00 UTC\n";
    writeFileSync(logPath, "[2026-08-19T00:00:00Z] === Taking a pre-update backup ===\n");
    let res = await fetch(`${baseUrl}/v1/system/source-update/status`, { headers: auth() });
    expect((await res.json()).status).toBe("running");

    systemctlShowResponse = "ActiveState=inactive\nSubState=dead\nExecMainStatus=0\nExecMainStartTimestamp=Wed 2026-08-19 00:00:00 UTC\n";
    writeFileSync(logPath, "[2026-08-19T00:05:00Z] === Update complete — now running v0.3.0. ===\n");
    res = await fetch(`${baseUrl}/v1/system/source-update/status`, { headers: auth() });
    const body = await res.json();
    expect(body.status).toBe("completed");

    // A later, independent poll reports the identical completed state — nothing was consumed.
    res = await fetch(`${baseUrl}/v1/system/source-update/status`, { headers: auth() });
    expect((await res.json()).status).toBe("completed");
  });

  it("status transitions running -> failed with the real error surfaced", async () => {
    systemctlShowResponse = "ActiveState=inactive\nSubState=dead\nExecMainStatus=1\nExecMainStartTimestamp=Wed 2026-08-19 00:00:00 UTC\n";
    writeFileSync(
      logPath,
      "[2026-08-19T00:00:00Z] === Verifying and staging release artifact ===\n[2026-08-19T00:02:00Z] ERROR Regenerated Caddyfile failed validation\n",
    );
    const res = await fetch(`${baseUrl}/v1/system/source-update/status`, { headers: auth() });
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error).toBe("Regenerated Caddyfile failed validation");

    const again = await (await fetch(`${baseUrl}/v1/system/source-update/status`, { headers: auth() })).json();
    expect(again.status).toBe("failed");
  });
});
