import { describe, expect, it } from "vitest";
import {
  CasambiEventBus,
  disableLocalButtonEvents,
  enableLocalButtonEvents,
  normalizeCloudEvent,
  normalizeLocalPacket,
} from "./event-engine.js";
import type { CasambiEvent } from "./cloud-transport.js";
import { decodeCasambiPacket, type CasambiPacket } from "./local-transport/index.js";

describe("CasambiEventBus", () => {
  it("delivers published events to subscribed listeners and honors unsubscribe", () => {
    const bus = new CasambiEventBus();
    const received: unknown[] = [];
    const off = bus.on((e) => received.push(e));
    bus.publish({ type: "diagnostic", kind: "error", ts: "now" });
    off();
    bus.publish({ type: "diagnostic", kind: "error", ts: "now" });
    expect(received).toHaveLength(1);
  });
});

/**
 * § Architecture Validation — before these existed, `casambi-driver.ts` had two separate private
 * methods (`onEvent`, `onLocalPacket`) each deciding independently what a raw signal meant. These
 * tests exercise the normalizers directly, proving ONE shared `CasambiSignal` shape covers both
 * transports' real, documented signals.
 */
describe("normalizeCloudEvent", () => {
  it("maps a pong response", () => {
    expect(normalizeCloudEvent({ response: "pong" })).toEqual({ kind: "pong" });
  });

  it("maps a wireStatus event", () => {
    expect(normalizeCloudEvent({ wireStatus: "invalidSession" })).toEqual({ kind: "wireStatus", status: "invalidSession" });
  });

  it("maps a unitChanged event into a unit signal", () => {
    const event: CasambiEvent = { method: "unitChanged", id: 45, dimLevel: 0.5, controls: [{ type: "Dimmer", value: 0.5 }] };
    expect(normalizeCloudEvent(event)).toEqual({
      kind: "unit",
      unit: expect.objectContaining({ id: 45, dimLevel: 0.5 }),
    });
  });

  it("maps a networkUpdated event", () => {
    expect(normalizeCloudEvent({ method: "networkUpdated" })).toEqual({ kind: "networkUpdated" });
  });

  it("ignores peerChanged and unknown methods", () => {
    expect(normalizeCloudEvent({ method: "peerChanged" })).toBeNull();
    expect(normalizeCloudEvent({ method: "somethingElse" })).toBeNull();
    expect(normalizeCloudEvent({})).toBeNull();
  });
});

describe("normalizeLocalPacket", () => {
  const noPrev = () => undefined;

  it("maps a NotifyControlValues (0x4B) packet into a unit signal, using getPrevUnit for merge", () => {
    const packet = decodeCasambiPacket("0.70.4.4b.5.1.c8\r\n", "hex-dot");
    expect(normalizeLocalPacket(packet, noPrev)).toEqual({
      kind: "unit",
      unit: expect.objectContaining({ id: 5, dimLevel: 200 / 255 }),
    });
  });

  it("passes the previously-known unit through getPrevUnit so state merges progressively", () => {
    const packet = decodeCasambiPacket("0.70.4.4b.5.10.1\r\n", "hex-dot"); // type 16 onOffToggle=1
    const seen: number[] = [];
    const signal = normalizeLocalPacket(packet, (id) => {
      seen.push(id);
      return { id: 5, dimLevel: 0.5, controls: [{ type: "dimmer", value: 0.5 }] };
    });
    expect(seen).toEqual([5]);
    expect(signal).toEqual({
      kind: "unit",
      unit: expect.objectContaining({ id: 5, on: true, dimLevel: 0.5 }),
    });
  });

  it("returns null for an empty NotifyControlValues response (p.315: 'contains only the target ID')", () => {
    const packet = decodeCasambiPacket("0.70.2.4b.5\r\n", "hex-dot");
    expect(normalizeLocalPacket(packet, noPrev)).toBeNull();
  });

  it("maps a button event (0x51)", () => {
    const packet = decodeCasambiPacket("0.70.5.51.9.1.0.2\r\n", "hex-dot");
    expect(normalizeLocalPacket(packet, noPrev)).toEqual({ kind: "button", unitId: 9, action: "short_press" });
  });

  it("maps a node-removed event (0x3A)", () => {
    const packet = decodeCasambiPacket("0.70.2.3a.7\r\n", "hex-dot");
    expect(normalizeLocalPacket(packet, noPrev)).toEqual({ kind: "unitRemoved", unitId: 7 });
  });

  it("maps a scene-called event (0x0D) as raw bits, never forced into SceneEvent's shape", () => {
    const packet = decodeCasambiPacket("0.70.9.d.ff.0.0.0.0.0.0.0d\r\n", "hex-dot");
    expect(normalizeLocalPacket(packet, noPrev)).toEqual({ kind: "sceneRaw", bits: [255, 0, 0, 0, 0, 0, 0, 13] });
  });

  it("returns null for every real-but-unwired opcode (e.g. 0x39 Node Status)", () => {
    const packet = decodeCasambiPacket("0.70.6.39.1.1.0.0.1\r\n", "hex-dot");
    expect(normalizeLocalPacket(packet, noPrev)).toBeNull();
  });
});

describe("enableLocalButtonEvents / disableLocalButtonEvents", () => {
  it("send the documented enable/disable request values (0xFD / 0)", async () => {
    const sent: CasambiPacket[] = [];
    const udp = { send: async (p: CasambiPacket) => void sent.push(p) };
    await enableLocalButtonEvents(udp, 0);
    await disableLocalButtonEvents(udp, 0);
    expect(sent).toEqual([
      { netId: 0, direction: "toCasambi", opcode: 0x50, args: [0xfd] },
      { netId: 0, direction: "toCasambi", opcode: 0x50, args: [0] },
    ]);
  });
});
