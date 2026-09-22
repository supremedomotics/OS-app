import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RealMatterController } from "./real-controller.js";
import { InMemoryMatterDeviceModelStore } from "./persistence.js";
import { MatterEngineError } from "./errors.js";
import {
  createCommissionableFixture,
  randomEphemeralPort,
  type CommissionableFixture,
} from "./test-support/commissionable-fixture.js";

/**
 * (§ Matter Controller Extension, Phase 3 — Generic Cluster Engine, end-to-end)
 *
 * Real read/write/invoke against a real commissioned `@matter/main` fixture — no mocks of
 * the protocol operations themselves (§ requirement 7). Reuses the exact fixture endpoints
 * Phase 2 already commissions/interviews: endpoint 1 (On/Off Light — `onOff`/`identify`
 * clusters), endpoint 2 (Dimmable Light), endpoint 3 (Color Temperature Light).
 */
describe("Matter Controller — generic cluster engine (Phase 3)", () => {
  const fixtures: CommissionableFixture[] = [];
  const controllers: RealMatterController[] = [];
  let dirs: string[] = [];
  let uniqueCounter = 0;

  function uniqueId(label: string): string {
    uniqueCounter += 1;
    return `${label}-${process.pid}-${uniqueCounter}`;
  }

  function tempDir(label: string): string {
    const d = mkdtempSync(join(tmpdir(), `matter-cluster-engine-${label}-`));
    dirs.push(d);
    return d;
  }

  afterEach(async () => {
    for (const c of controllers) await c.disconnect().catch(() => {});
    for (const f of fixtures) await f.close().catch(() => {});
    controllers.length = 0;
    fixtures.length = 0;
    // § same live-confirmed dangling-lazy-persist race documented in Phase 2's own
    // `discovery.e2e.test.ts` — a bounded wait, never a production behavior change.
    await new Promise((r) => setTimeout(r, 100));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  async function commissionFixture(label = "fixture"): Promise<{ nodeId: string; controller: RealMatterController }> {
    const fixture = await createCommissionableFixture(uniqueId(label), tempDir(label));
    fixtures.push(fixture);
    const controller = new RealMatterController({
      storagePath: tempDir(`${label}-controller`),
      deviceModelStore: new InMemoryMatterDeviceModelStore(),
      port: randomEphemeralPort(),
      nodeId: uniqueId(`${label}-controller`),
      commissionTimeoutSeconds: 12,
    });
    controllers.push(controller);
    await controller.connect();

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const info = await controller.commission({
          passcode: fixture.passcode,
          discriminator: fixture.discriminator,
          shortDiscriminator: false,
          source: "manual",
        });
        return { nodeId: info.nodeId, controller };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  const ONOFF_LIGHT_ENDPOINT = 1;
  const DIMMABLE_LIGHT_ENDPOINT = 2;

  it("A/B/C: real read, write, and command invocation round-trip against a real commissioned device", async () => {
    const { nodeId, controller } = await commissionFixture();

    // A: attribute read — the real On/Off Light starts off.
    const initial = await controller.readAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "onOff");
    expect(initial.value).toBe(false);
    expect(initial.nodeId).toBe(nodeId);
    expect(initial.endpointId).toBe(ONOFF_LIGHT_ENDPOINT);
    expect(initial.attributeName).toBe("onOff");
    expect(typeof initial.timestamp).toBe("string");

    // C: command invocation — real "on" command, verified via a real subsequent read (not a
    // locally-fabricated result).
    const invokeResult = await controller.invokeCommand(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "on");
    expect(invokeResult.commandName).toBe("on");
    const afterOn = await controller.readAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "onOff");
    expect(afterOn.value).toBe(true);

    // B: attribute write — Identify's `identifyTime` is a real writable uint16 attribute
    // present on every fixture endpoint; write then read back to verify the REAL change.
    const written = await controller.writeAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "identify", "identifyTime", 42);
    expect(written.value).toBe(42);
    const readBack = await controller.readAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "identify", "identifyTime");
    expect(readBack.value).toBe(42);
  }, 60_000);

  it("D/E/F/G: invalid endpoint/cluster/attribute/command each produce a deterministic structured error", async () => {
    const { nodeId, controller } = await commissionFixture();

    // D: invalid endpoint.
    await expect(controller.readAttribute(nodeId, 99, "onOff", "onOff")).rejects.toMatchObject({
      reason: "endpoint_not_found",
    } satisfies Partial<MatterEngineError>);

    // E: invalid cluster.
    await expect(controller.readAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "notARealCluster", "onOff")).rejects.toMatchObject({
      reason: "cluster_not_found",
    } satisfies Partial<MatterEngineError>);

    // F: invalid attribute.
    await expect(controller.readAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "notARealAttribute")).rejects.toMatchObject({
      reason: "attribute_not_found",
    } satisfies Partial<MatterEngineError>);

    // G: invalid command.
    await expect(controller.invokeCommand(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "notARealCommand")).rejects.toMatchObject({
      reason: "command_not_found",
    } satisfies Partial<MatterEngineError>);

    // Every error carries enough structured context to identify exactly what failed.
    try {
      await controller.readAttribute(nodeId, 99, "onOff", "onOff");
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(MatterEngineError);
      const e = err as MatterEngineError;
      expect(e.context.nodeId).toBe(nodeId);
      expect(e.context.endpointId).toBe(99);
      expect(e.context.operation).toBe("read");
    }
  }, 60_000);

  it("H: operations remain scoped to the requested endpoint", async () => {
    const { nodeId, controller } = await commissionFixture();

    await controller.invokeCommand(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "on");
    const onOffLightState = await controller.readAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "onOff");
    const dimmableLightState = await controller.readAttribute(nodeId, DIMMABLE_LIGHT_ENDPOINT, "onOff", "onOff");

    expect(onOffLightState.value).toBe(true);
    // The Dimmable Light endpoint has its OWN onOff cluster instance — turning on endpoint 1
    // must never leak into endpoint 2's real state.
    expect(dimmableLightState.value).toBe(false);
  }, 60_000);

  it("I: operations cannot accidentally cross real node boundaries", async () => {
    const nodeA = await commissionFixture("node-a");
    const nodeB = await commissionFixture("node-b");

    await nodeA.controller.invokeCommand(nodeA.nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "on");

    const aState = await nodeA.controller.readAttribute(nodeA.nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "onOff");
    expect(aState.value).toBe(true);

    // Node B's controller has never commissioned node A — addressing node A's real id through
    // node B's controller must fail with a real, deterministic error, never silently succeed
    // or return node A's state.
    await expect(
      nodeB.controller.readAttribute(nodeA.nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "onOff"),
    ).rejects.toMatchObject({ reason: "node_not_commissioned" } satisfies Partial<MatterEngineError>);

    // Node B's own device, addressed through its own controller, is unaffected and independent.
    const bState = await nodeB.controller.readAttribute(nodeB.nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "onOff");
    expect(bState.value).toBe(false);
  }, 90_000);
});
