/**
 * (§ Matter Controller Extension, Phase 3.2 — separate-process test fixture, NOT shipped
 * runtime code)
 *
 * Runs a REAL `@matter/main` commissionable multi-endpoint node in its OWN OS process
 * (forked by `./fixture-process-handle.ts`), so Matter packets between it and the
 * controller-under-test travel over the actual OS networking stack across a real process
 * boundary — never in-process function calls, never a mocked transport (§ Phase 3.2
 * objective). Reuses the exact same endpoint construction as the in-process fixture
 * (`./commissionable-fixture.ts`) — no separate/duplicated device definition.
 *
 * IPC with the parent is ORCHESTRATION ONLY (ready/port/passcode/discriminator, shutdown) —
 * never Matter protocol traffic, which flows entirely over the real UDP socket
 * `@matter/main` itself binds.
 */
import { createCommissionableFixture, type CommissionableFixture } from "./commissionable-fixture.js";

export type FixtureProcessMessage =
  | { type: "ready"; port: number; passcode: number; discriminator: number }
  | { type: "error"; message: string };

export type FixtureProcessCommand = { type: "shutdown" };

async function main(): Promise<void> {
  const nodeId = process.env.MATTER_FIXTURE_NODE_ID;
  const storagePath = process.env.MATTER_FIXTURE_STORAGE_PATH;
  if (!nodeId || !storagePath) {
    throw new Error("fixture-process: MATTER_FIXTURE_NODE_ID and MATTER_FIXTURE_STORAGE_PATH env vars are required");
  }

  let fixture: CommissionableFixture;
  try {
    fixture = await createCommissionableFixture(nodeId, storagePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.send?.({ type: "error", message } satisfies FixtureProcessMessage);
    process.exitCode = 1;
    return;
  }

  process.send?.({
    type: "ready",
    port: fixture.port,
    passcode: fixture.passcode,
    discriminator: fixture.discriminator,
  } satisfies FixtureProcessMessage);

  process.on("message", (raw: FixtureProcessCommand) => {
    if (raw?.type === "shutdown") {
      fixture
        .close()
        .catch(() => {})
        .finally(() => process.exit(0));
    }
  });

  // § requirement 8 — exit cleanly on test/parent termination even if no explicit shutdown
  // message arrives (a crashed or killed parent must never leave this process listening).
  process.on("disconnect", () => {
    fixture
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.send?.({ type: "error", message } satisfies FixtureProcessMessage);
  process.exitCode = 1;
});
