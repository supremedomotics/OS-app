import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { describe, expect, it } from "vitest";
import { SipProtocolDriver, type SipDoorStation, type SipRingEvent } from "./sip-driver.js";

/** A fake SIP door station: records door-open calls and can fire ring events. */
class FakeStation implements SipDoorStation {
  readonly opened: string[] = [];
  started = false;
  private handler: ((e: SipRingEvent) => void) | null = null;
  async start() {
    this.started = true;
  }
  async stop() {
    this.started = false;
  }
  async openDoor(stationId: string) {
    this.opened.push(stationId);
  }
  onRing(handler: (e: SipRingEvent) => void) {
    this.handler = handler;
  }
  ring(stationId: string, caller?: string) {
    this.handler?.({ stationId, caller });
  }
}

describe("SipProtocolDriver (fake door station)", () => {
  it("opens the door on unlock and pulses a sensor on ring", async () => {
    const station = new FakeStation();
    const driver = new SipProtocolDriver({ createStation: async () => station });
    await driver.connect();
    expect(station.started).toBe(true);

    const dev = "device-front-door" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "lock", address: "sip:door@pbx" });
    await driver.bind({ deviceId: dev, capability: "sensor", address: "sip:door@pbx" });

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));

    // Unlock → the station opens the door + reflects "unlocked".
    await driver.command(dev, { capability: "lock", action: "unlock" });
    expect(station.opened).toEqual(["sip:door@pbx"]);
    expect(driver.getState(dev, "lock")).toEqual({ kind: "lock", locked: false, jammed: false });

    // A doorbell ring surfaces as a sensor event.
    station.ring("sip:door@pbx", "0123");
    const ring = events.find((e) => e.capability === "sensor");
    expect(ring?.state).toEqual({ kind: "sensor", value: 1, unit: "", measure: "ring" });
  });

  it("rejects unsupported capabilities at bind time", async () => {
    const driver = new SipProtocolDriver({ createStation: async () => new FakeStation() });
    await driver.connect();
    await expect(
      driver.bind({ deviceId: "x" as DeviceId, capability: "brightness", address: "sip:door@pbx" }),
    ).rejects.toThrow(/not supported/);
  });
});
