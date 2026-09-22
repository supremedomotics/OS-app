/**
 * (§ Matter Controller Extension, Phase 3.2 — separate-process test fixture, NOT shipped
 * runtime code)
 *
 * Parent-side handle: forks `./fixture-process.ts` as a genuinely separate OS process (real
 * PID, real independent socket stack — not merely a separate object in this same Node.js
 * process, per Phase 3.2's explicit objective) and waits for its real bound port over IPC.
 * IPC here carries ONLY orchestration data (ready/port/passcode/discriminator/shutdown) —
 * never Matter protocol traffic, which travels over the real UDP socket the child binds.
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FixtureProcessCommand, FixtureProcessMessage } from "./fixture-process.js";

export interface RemoteFixtureHandle {
  pid: number;
  port: number;
  passcode: number;
  discriminator: number;
  shutdown(): Promise<void>;
}

/** Every spawned child this process is responsible for — killed by `killAllFixtureProcesses()`
 * as a last-resort safety net (§ requirement — a failed test must never leave a stale Matter
 * process listening). Test files call that in a top-level `afterAll`. */
const activeChildren = new Set<ChildProcess>();

export function killAllFixtureProcesses(): void {
  for (const child of activeChildren) {
    if (!child.killed) child.kill("SIGKILL");
  }
  activeChildren.clear();
}

export async function spawnFixtureProcess(nodeId: string, storagePath: string, timeoutMs = 20_000): Promise<RemoteFixtureHandle> {
  const entry = fileURLToPath(new URL("./fixture-process.ts", import.meta.url));

  const child = fork(entry, [], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, MATTER_FIXTURE_NODE_ID: nodeId, MATTER_FIXTURE_STORAGE_PATH: storagePath },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  activeChildren.add(child);
  // § the fixture process's own @matter/main diagnostic logs are essential for diagnosing a
  // real commissioning failure across the process boundary — piped through with a `[fixture
  // pid]` prefix rather than silently discarded.
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[fixture ${child.pid}] ${chunk}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[fixture ${child.pid}] ${chunk}`));

  const ready = await new Promise<FixtureProcessMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture-process: no ready message within ${timeoutMs}ms`)), timeoutMs);
    child.once("message", (msg: FixtureProcessMessage) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture-process: exited early (code ${code}) before sending ready`));
    });
  }).catch((err) => {
    if (!child.killed) child.kill("SIGKILL");
    activeChildren.delete(child);
    throw err;
  });

  if (ready.type === "error") {
    if (!child.killed) child.kill("SIGKILL");
    activeChildren.delete(child);
    throw new Error(`fixture-process: startup failed — ${ready.message}`);
  }

  const shutdown = async (): Promise<void> => {
    if (child.killed || child.exitCode !== null) {
      activeChildren.delete(child);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      const cmd: FixtureProcessCommand = { type: "shutdown" };
      child.send(cmd);
    });
    activeChildren.delete(child);
  };

  return { pid: child.pid!, port: ready.port, passcode: ready.passcode, discriminator: ready.discriminator, shutdown };
}
