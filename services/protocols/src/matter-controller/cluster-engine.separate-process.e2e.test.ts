import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RealMatterController } from "./real-controller.js";
import { InMemoryMatterDeviceModelStore } from "./persistence.js";
import { MatterEngineError } from "./errors.js";
import { spawnFixtureProcess, killAllFixtureProcesses, type RemoteFixtureHandle } from "./test-support/fixture-process-handle.js";
import { randomEphemeralPort } from "./test-support/commissionable-fixture.js";

/**
 * (§ Matter Controller Extension, Phase 3.2 — separate-OS-process validation)
 *
 * The fixture runs in a GENUINELY SEPARATE OS process (`test-support/fixture-process.ts`,
 * forked by `test-support/fixture-process-handle.ts`) — a real PID with its own independent
 * socket stack, not merely a separate object in this same Node.js process. This is the
 * control for Phase 3.1's finding that same-process `@matter/main` UDP delivery is
 * unreliable on this host: if commissioning/read/write/invoke succeed here, over the real OS
 * network stack across a real process boundary, Phase 3's cluster engine is validated;
 * Phase 3.1's same-process limitation was specific to sharing one process, not a defect in
 * the engine itself. Commissioning uses the deterministic `commissionAtAddress()` path
 * (§ Phase 3.1) — mDNS discovery is not involved at all here, by design, per this phase's
 * explicit instruction not to re-debug mDNS first.
 */
describe("Matter Controller — generic cluster engine, separate OS process (Phase 3.2)", () => {
  const controllers: RealMatterController[] = [];
  const handles: RemoteFixtureHandle[] = [];
  let dirs: string[] = [];
  let uniqueCounter = 0;

  function uniqueId(label: string): string {
    uniqueCounter += 1;
    return `${label}-${process.pid}-${uniqueCounter}`;
  }

  function tempDir(label: string): string {
    const d = mkdtempSync(join(tmpdir(), `matter-cluster-engine-sp-${label}-`));
    dirs.push(d);
    return d;
  }

  afterEach(async () => {
    for (const c of controllers) await c.disconnect().catch(() => {});
    for (const h of handles) await h.shutdown().catch(() => {});
    controllers.length = 0;
    handles.length = 0;
    await new Promise((r) => setTimeout(r, 100));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  // § requirement — a failed/timed-out test must never leave a stale Matter fixture process
  // listening on the port; this is the last-resort net beyond the per-test afterEach above.
  afterAll(() => {
    killAllFixtureProcesses();
  });

  const ONOFF_LIGHT_ENDPOINT = 1;
  const DIMMABLE_LIGHT_ENDPOINT = 2;

  async function commissionRemoteFixture(label = "fixture") {
    const handle = await spawnFixtureProcess(uniqueId(label), tempDir(label));
    handles.push(handle);

    const controller = new RealMatterController({
      storagePath: tempDir(`${label}-controller`),
      deviceModelStore: new InMemoryMatterDeviceModelStore(),
      port: randomEphemeralPort(),
      nodeId: uniqueId(`${label}-controller`),
      commissionTimeoutSeconds: 15,
    });
    controllers.push(controller);
    await controller.connect();

    const info = await controller.commissionAtAddress(
      { ip: "127.0.0.1", port: handle.port },
      { passcode: handle.passcode, discriminator: handle.discriminator, shortDiscriminator: false, source: "manual" },
    );
    return { nodeId: info.nodeId, controller, handle };
  }

  it(
    "A/B/C: real commission (PASE+CASE) + read + write + read-back + invoke across a real separate OS process",
    async () => {
      const { nodeId, controller } = await commissionRemoteFixture();

      // Commissioning + interview already happened for real inside commissionRemoteFixture();
      // confirm the model reflects a genuinely commissioned, interviewed node before touching
      // cluster operations.
      const model = controller.getDeviceModel(nodeId);
      expect(model?.interviewState).toBe("complete");
      expect(model?.endpoints.length).toBeGreaterThanOrEqual(4);

      // A: real read.
      const initial = await controller.readAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "onOff");
      expect(initial.value).toBe(false);

      // C: real invoke, verified via a real subsequent read.
      const invokeResult = await controller.invokeCommand(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "on");
      expect(invokeResult.commandName).toBe("on");
      const afterOn = await controller.readAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "onOff");
      expect(afterOn.value).toBe(true);

      // B: real write + real read-back.
      const written = await controller.writeAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "identify", "identifyTime", 42);
      expect(written.value).toBe(42);
      const readBack = await controller.readAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "identify", "identifyTime");
      expect(readBack.value).toBe(42);
    },
    60_000,
  );

  it(
    "D/E/F/G: invalid endpoint/cluster/attribute/command each produce a deterministic structured error",
    async () => {
      const { nodeId, controller } = await commissionRemoteFixture();

      await expect(controller.readAttribute(nodeId, 99, "onOff", "onOff")).rejects.toMatchObject({
        reason: "endpoint_not_found",
      } satisfies Partial<MatterEngineError>);

      await expect(controller.readAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "notARealCluster", "onOff")).rejects.toMatchObject({
        reason: "cluster_not_found",
      } satisfies Partial<MatterEngineError>);

      await expect(controller.readAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "notARealAttribute")).rejects.toMatchObject({
        reason: "attribute_not_found",
      } satisfies Partial<MatterEngineError>);

      await expect(controller.invokeCommand(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "notARealCommand")).rejects.toMatchObject({
        reason: "command_not_found",
      } satisfies Partial<MatterEngineError>);
    },
    60_000,
  );

  it(
    "H: operations remain scoped to the requested endpoint",
    async () => {
      const { nodeId, controller } = await commissionRemoteFixture();

      await controller.invokeCommand(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "on");
      const onOffLightState = await controller.readAttribute(nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "onOff");
      const dimmableLightState = await controller.readAttribute(nodeId, DIMMABLE_LIGHT_ENDPOINT, "onOff", "onOff");

      expect(onOffLightState.value).toBe(true);
      expect(dimmableLightState.value).toBe(false);
    },
    60_000,
  );

  it(
    "I: operations cannot accidentally cross real node boundaries (two separate fixture processes)",
    async () => {
      const nodeA = await commissionRemoteFixture("node-a");
      const nodeB = await commissionRemoteFixture("node-b");

      await nodeA.controller.invokeCommand(nodeA.nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "on");

      const aState = await nodeA.controller.readAttribute(nodeA.nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "onOff");
      expect(aState.value).toBe(true);

      await expect(
        nodeB.controller.readAttribute(nodeA.nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "onOff"),
      ).rejects.toMatchObject({ reason: "node_not_commissioned" } satisfies Partial<MatterEngineError>);

      const bState = await nodeB.controller.readAttribute(nodeB.nodeId, ONOFF_LIGHT_ENDPOINT, "onOff", "onOff");
      expect(bState.value).toBe(false);
    },
    90_000,
  );
});
