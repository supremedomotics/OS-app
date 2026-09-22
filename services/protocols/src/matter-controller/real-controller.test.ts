import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RealMatterController } from "./real-controller.js";

/**
 * (§ Matter Controller Extension, Phase 1 — foundation self-check)
 *
 * Exercises the real `@matter/main` lifecycle (no fake/mocked controller): a fresh
 * storage-backed node starts, is independently reconnectable, enumerates zero peers
 * before anything is commissioned, and cleanly closes. Commissioning/invoke/subscribe
 * against a real peer device need a second real `@matter/main` node to commission
 * against and are exercised in Phase 2+ once discovery/device-interview lands.
 */
describe("RealMatterController — Phase 1 lifecycle foundation", () => {
  let dir: string;
  let uniqueCounter = 0;
  // § each real @matter/main node created in this SAME process needs its own id — reusing
  // the default id across every test in this file hit a real "SessionManager unavailable ...
  // groupDataCounter" crash (cumulative `Environment.default`-keyed state collision across
  // repeated same-id create/close cycles in one process), not a SupremeOS logic bug.
  function uniqueNodeId(): string {
    uniqueCounter += 1;
    return `test-controller-${process.pid}-${uniqueCounter}`;
  }

  // § the standard Matter port (5540) may genuinely be held by another real process on a
  // shared dev machine (e.g. a locally-running SupremeOS gateway) — a real, legitimate
  // conflict this test must not fight over, so it always asks for its own random port.
  function randomPort(): number {
    return 49152 + Math.floor(Math.random() * 15000);
  }

  afterEach(async () => {
    // § same live-confirmed dangling-lazy-persist race documented in
    // `matter-bridge/real-server.persistence.test.ts`'s own `afterEach`: a just-started
    // `ServerEndpointStores` lazy write is not reliably awaited by `disconnect()` before it
    // resolves, so deleting the temp directory immediately can race a write still in flight.
    // Test-cleanup-only bounded wait — not a production behavior change.
    await new Promise((r) => setTimeout(r, 100));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("starts, persists storage across a reconnect, lists zero peers, and closes cleanly", async () => {
    dir = mkdtempSync(join(tmpdir(), "matter-controller-test-"));
    const nodeId = uniqueNodeId();
    const controller = new RealMatterController({ storagePath: dir, nodeId, port: randomPort() });

    await controller.connect();
    await expect(controller.nodes()).resolves.toEqual([]);
    await controller.disconnect();

    // Reconnect against the same storage root AND same node id — must not throw (fabric
    // survives restart).
    const controller2 = new RealMatterController({ storagePath: dir, nodeId, port: randomPort() });
    await controller2.connect();
    await expect(controller2.nodes()).resolves.toEqual([]);
    await controller2.disconnect();
  }, 20_000);

  it("rejects nodes()/commission() before connect() — never silently returns empty for 'not connected'", async () => {
    const controller = new RealMatterController({});
    await expect(controller.nodes()).rejects.toThrow("not connected");
    await expect(
      controller.commission({ passcode: 20202021, discriminator: 3840, source: "manual" }),
    ).rejects.toThrow("not connected");
  });

  it("invoke() against an uncommissioned node honestly reports 'never commissioned' rather than pretending to control a device", async () => {
    // § Phase 3 — invoke() is now real (delegates to the generic cluster engine); this
    // asserts the deterministic, structured failure for a target that was never
    // commissioned, not a generic "not implemented" stub (that class of test now lives in
    // `discovery.e2e.test.ts`'s real commission→interview→read/write/invoke suite).
    dir = mkdtempSync(join(tmpdir(), "matter-controller-test-"));
    const controller = new RealMatterController({ storagePath: dir, nodeId: uniqueNodeId(), port: randomPort() });
    await controller.connect();
    await expect(
      controller.invoke({ nodeId: "never-commissioned", endpoint: 1 }, "OnOff", "on", {}),
    ).rejects.toThrow(/never commissioned/);
    await controller.disconnect();
  }, 20_000);
});
