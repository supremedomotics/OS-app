import { describe, expect, it } from "vitest";
import { CloudCommandEngine, LocalCommandEngine } from "./command-engine.js";
import { CasambiFeedbackEngine } from "./feedback-engine.js";
import type { CasambiWire } from "./cloud-transport.js";
import { CASAMBI_TARGET_TYPE, type CasambiPacket } from "./local-transport/index.js";

function fakeWire(): CasambiWire & { calls: { unitId: number; targetControls: Record<string, unknown> }[] } {
  const calls: { unitId: number; targetControls: Record<string, unknown> }[] = [];
  return {
    calls,
    connected: true,
    open() {},
    ping() {},
    controlUnit(_wire, unitId, targetControls) {
      calls.push({ unitId, targetControls });
    },
    close() {},
  };
}

/**
 * § Architecture Validation — before this file existed, the "resolve a command → send it" path
 * was inline in `casambi-driver.ts`'s `command()` method, branching on connection mode. These
 * tests exercise each `CasambiCommandEngine` implementation directly, independent of the driver,
 * proving the interface itself (not just the driver's use of it) does the right thing.
 */
describe("CloudCommandEngine", () => {
  it("resolves WHAT to send via commandToTargetControls and writes it through the feedback engine", async () => {
    const wire = fakeWire();
    const engine = new CloudCommandEngine(new CasambiFeedbackEngine(() => wire));
    await engine.send(45, { capability: "onoff", action: "on" }, null);
    expect(wire.calls).toEqual([{ unitId: 45, targetControls: { OnOff: { value: 1 } } }]);
  });

  it("throws for an unsupported capability rather than sending nothing silently", async () => {
    const engine = new CloudCommandEngine(new CasambiFeedbackEngine(() => fakeWire()));
    await expect(engine.send(45, { capability: "position", action: "stop" }, null)).rejects.toThrow(/unsupported command/);
  });

  it("propagates the feedback engine's 'not connected' error when the wire is down", async () => {
    const engine = new CloudCommandEngine(new CasambiFeedbackEngine(() => null));
    await expect(engine.send(45, { capability: "onoff", action: "on" }, null)).rejects.toThrow(/not connected/);
  });
});

describe("LocalCommandEngine", () => {
  function fakeUdp() {
    const sent: CasambiPacket[] = [];
    return { sent, send: async (packet: CasambiPacket) => void sent.push(packet) };
  }

  it("resolves WHAT to send via localCommandToUdpPacket and writes it through the UDP engine", async () => {
    const udp = fakeUdp();
    const engine = new LocalCommandEngine(udp, 0);
    await engine.send(5, { capability: "onoff", action: "on" }, null);
    // § live-confirmed fix — full-length 0x20 with explicit 0 Duration; see local-command-mapper.ts.
    expect(udp.sent).toEqual([{ netId: 0, direction: "toCasambi", opcode: 0x20, args: [255, 0, 0, CASAMBI_TARGET_TYPE.device, 5] }]);
  });

  it("uses the configured Net ID, not a hard-coded one", async () => {
    const udp = fakeUdp();
    const engine = new LocalCommandEngine(udp, 7);
    await engine.send(5, { capability: "onoff", action: "off" }, null);
    expect(udp.sent[0].netId).toBe(7);
  });

  it("throws for an unsupported capability (position) rather than fabricating a mapping", async () => {
    const udp = fakeUdp();
    const engine = new LocalCommandEngine(udp, 0);
    // open/close/set all map onto the position slider element now; "stop" has no element at all.
    await expect(engine.send(5, { capability: "position", action: "stop" }, null)).rejects.toThrow(/unsupported command/);
  });
});
