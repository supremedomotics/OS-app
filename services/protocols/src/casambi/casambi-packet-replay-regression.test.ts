import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { InProcessEventBus } from "@supreme/messaging";
import { NatsUdpTransportClient } from "@supreme/lan";
import { UdpTransportServer, replayableDgramSocket, fakeDgramSocket, loadCaptureJson, type PacketCapture } from "@supreme/lan/server";
import { CasambiProtocolDriver } from "./casambi-driver.js";
import type { CasambiDriverEvent } from "./event-engine.js";
import { buildFailureAnalysisReport, formatFailureAnalysisReport } from "./failure-analysis.js";
import type { DeviceId } from "@supreme/domain-model";

/**
 * § Final Hardware Validation — Packet Replay Framework, automatic regression testing.
 * "Every replay session should automatically become a regression test... Running CI should
 * replay every capture. No hardware required." This file does exactly that: every `.json`
 * capture under `tests/regression/casambi/` (RECURSIVELY — captures are organized into
 * per-category subdirectories: `living-room/`, `kitchen/`, `office/`, `button-events/`,
 * `sensor-events/`, `dimming/`, `scenes/`, see that directory's own `README.md`) is loaded and
 * replayed through the REAL pipeline (`CasambiProtocolDriver` -> real `NatsUdpTransportClient` ->
 * real `UdpTransportServer` -> a `replayableDgramSocket`) — the identical code path a real
 * Lithernet gateway's traffic would take, per the Packet Replay Framework's design (see
 * `@supreme/lan/server`'s `replay-dgram-socket.ts`). Adding a new `.json` file anywhere under that
 * directory is enough to add it to this suite — no test code changes required for a new capture.
 */
const CAPTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../tests/regression/casambi");

async function loadAllCaptures(): Promise<{ file: string; capture: PacketCapture }[]> {
  const entries = await readdir(CAPTURES_DIR, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort();
  return Promise.all(files.map(async (file) => ({ file: path.relative(CAPTURES_DIR, file), capture: await loadCaptureJson(file) })));
}

async function setupDriverOverRealLan() {
  const bus = new InProcessEventBus();
  const gatewaySocket = replayableDgramSocket(fakeDgramSocket);
  const server = new UdpTransportServer(bus, () => gatewaySocket);
  await server.start();
  const driver = new CasambiProtocolDriver({
    connectionMode: "local",
    local: {
      gatewayIp: "192.168.0.45",
      restPort: 80,
      udpPort: 10009,
      netId: 0xc,
      udpTransportFactory: () => new NatsUdpTransportClient(bus, { timeoutMs: 1_000 }),
    },
  });
  await driver.connect();
  return { driver, gatewaySocket, server };
}

describe("Casambi Packet Replay — automatic regression suite (no hardware required)", () => {
  it("finds at least the living-room/kitchen/office reference captures", async () => {
    const captures = await loadAllCaptures();
    expect(captures.map((c) => c.capture.name).sort()).toEqual(["kitchen", "living-room", "office"]);
  });

  it("every capture in tests/regression/casambi/ replays through the real pipeline without an unhandled error, and every packet is a real, observed reception", async () => {
    const captures = await loadAllCaptures();
    for (const { file, capture } of captures) {
      const { driver, gatewaySocket } = await setupDriverOverRealLan();
      for (const packet of capture.packets) gatewaySocket.injectDatagram(packet);
      await new Promise((r) => setTimeout(r, 20)); // one real NATS publish/subscribe hop per packet
      const monitor = driver.getCasambiTransportMonitor();
      expect(monitor.adapter?.packetsReceived, `${file}: transport should have received every replayed packet`).toBe(capture.packets.length);
      await driver.disconnect();
    }
  });

  it("living-room.json: the real hardware-captured NotifyControlValues packet discovers a unit", async () => {
    const captures = await loadAllCaptures();
    const capture = captures.find((c) => c.capture.name === "living-room")!.capture;
    const { driver, gatewaySocket } = await setupDriverOverRealLan();

    for (const packet of capture.packets) gatewaySocket.injectDatagram(packet);
    await new Promise((r) => setTimeout(r, 20));

    const monitor = driver.getCasambiTransportMonitor();
    expect(monitor.adapter?.decoded).toBe(1);
    expect(monitor.adapter?.decodeFailures).toBe(0);
    expect(monitor.driver.discoveryEvents).toBe(1); // Target_ID=0x1e, first time seen
    // This real payload's controls (presence sensor + light sensor lux + 8 unnamed onOffToggle
    // relays) map to Supreme's "sensor" capability per entity-mapper.ts's capabilitiesFromUnit —
    // NOT "onoff"/"brightness" (onOffToggle sets unit.on directly, it never pushes a "dimmer"
    // control, so capabilitiesFromUnit's sensor branch wins). No binding exists yet in this test,
    // so feedbackEvents stays 0 here — feedback only counts for a BOUND capability (see the next
    // test for the bound-device version of this same capture).
    expect(monitor.driver.entities).toBe(1);
    expect(monitor.driver.feedbackEvents).toBe(0);
    await driver.disconnect();
  });

  it("kitchen.json: a button-press capture fires a typed ButtonEvent", async () => {
    const captures = await loadAllCaptures();
    const capture = captures.find((c) => c.capture.name === "kitchen")!.capture;
    const { driver, gatewaySocket } = await setupDriverOverRealLan();

    const events: CasambiDriverEvent[] = [];
    driver.onDriverEvent((e) => events.push(e));
    for (const packet of capture.packets) gatewaySocket.injectDatagram(packet);
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toContainEqual({ type: "button", unitId: 9, action: "short_press", ts: expect.any(String) });
    const monitor = driver.getCasambiTransportMonitor();
    expect(monitor.adapter?.decoded).toBe(1);
    await driver.disconnect();
  });

  it("office.json: a well-formed but unmapped opcode is decoded, then honestly reported as ignored — never a silent drop", async () => {
    const captures = await loadAllCaptures();
    const capture = captures.find((c) => c.capture.name === "office")!.capture;
    const { driver, gatewaySocket } = await setupDriverOverRealLan();

    for (const packet of capture.packets) gatewaySocket.injectDatagram(packet);
    await new Promise((r) => setTimeout(r, 20));

    const monitor = driver.getCasambiTransportMonitor();
    expect(monitor.adapter?.decoded).toBe(1);
    expect(monitor.adapter?.decodeFailures).toBe(0);
    expect(monitor.driver.unmappedOpcodeEvents).toBe(1);
    expect(monitor.driver.lastUnmappedOpcode).toBe(0x39);
    expect(monitor.driver.discoveryEvents).toBe(0);
    expect(monitor.driver.feedbackEvents).toBe(0);
    await driver.disconnect();
  });

  it("office.json's Failure Analysis report correctly names the exact real failure — no hardware needed to verify this", async () => {
    const captures = await loadAllCaptures();
    const capture = captures.find((c) => c.capture.name === "office")!.capture;
    const { driver, gatewaySocket } = await setupDriverOverRealLan();
    for (const packet of capture.packets) gatewaySocket.injectDatagram(packet);
    await new Promise((r) => setTimeout(r, 20));

    const report = buildFailureAnalysisReport(driver.getCasambiTransportMonitor());
    expect(report.healthy).toBe(false);
    expect(report.firstFailingStage).toBe("Discovery / Driver");
    expect(formatFailureAnalysisReport(report)).toContain("Discovery ignored packet — opcode 0x39 not mapped");
    await driver.disconnect();
  });

  it("a bound device sees real state from the living-room replay (end-to-end through a real binding)", async () => {
    const captures = await loadAllCaptures();
    const capture = captures.find((c) => c.capture.name === "living-room")!.capture;
    const { driver, gatewaySocket } = await setupDriverOverRealLan();
    const dev = "replay-dev-30" as DeviceId;
    // The living-room capture's Target_ID is 0x1e = 30. Its controls (presence + lux + 8
    // onOffToggle relays) map to Supreme's "sensor" capability, verified above — bind that, not
    // "onoff"/"brightness", to see real feedback.
    await driver.bind({ deviceId: dev, capability: "sensor", address: "casambi:30" });

    for (const packet of capture.packets) gatewaySocket.injectDatagram(packet);
    await new Promise((r) => setTimeout(r, 20));

    expect(driver.getState(dev, "sensor")).toEqual({ kind: "sensor", value: 0, unit: "", measure: "presence" });
    expect(driver.getCasambiTransportMonitor().driver.feedbackEvents).toBe(1);
    await driver.disconnect();
  });
});
