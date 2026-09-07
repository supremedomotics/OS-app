import { describe, expect, it } from "vitest";
import { buildDiscoveryResponse } from "./alexa.js";
import type { HubDevice } from "./hub-router.js";

/** § Correctness Fix — a device whose capabilities produce zero real Alexa
 * interfaces must never be discovered at all (never advertised-but-uncontrollable). */
describe("buildDiscoveryResponse — never advertises an uncontrollable device", () => {
  it("discovers a device with a real, mapped capability", () => {
    const devices: HubDevice[] = [
      { id: "d1", name: "Lamp", roomId: "lr", supremeType: "light", capabilities: [{ kind: "onoff" }] },
    ];
    const body = buildDiscoveryResponse(devices) as { event: { payload: { endpoints: { endpointId: string }[] } } };
    expect(body.event.payload.endpoints).toHaveLength(1);
    expect(body.event.payload.endpoints[0]?.endpointId).toBe("d1");
  });

  it("omits a fan-only device — Alexa has no controllable interface for `fan`", () => {
    const devices: HubDevice[] = [
      { id: "d2", name: "Bathroom Fan", roomId: "bath", supremeType: "fan", capabilities: [{ kind: "fan" }] },
    ];
    const body = buildDiscoveryResponse(devices) as { event: { payload: { endpoints: unknown[] } } };
    expect(body.event.payload.endpoints).toEqual([]);
  });

  it("omits a sensor-only device — `sensor` is read-only and has no Alexa interface", () => {
    const devices: HubDevice[] = [
      { id: "d3", name: "Motion Sensor", roomId: "hall", supremeType: "sensor", capabilities: [{ kind: "sensor" }] },
    ];
    const body = buildDiscoveryResponse(devices) as { event: { payload: { endpoints: unknown[] } } };
    expect(body.event.payload.endpoints).toEqual([]);
  });

  it("omits a vacuum-only device — `vacuum` has no Alexa interface mapping", () => {
    const devices: HubDevice[] = [
      { id: "d4", name: "Robot Vacuum", roomId: "lr", supremeType: "vacuum", capabilities: [{ kind: "vacuum" }] },
    ];
    const body = buildDiscoveryResponse(devices) as { event: { payload: { endpoints: unknown[] } } };
    expect(body.event.payload.endpoints).toEqual([]);
  });

  it("still discovers a fan+onoff device — onoff genuinely gives Alexa a real control", () => {
    const devices: HubDevice[] = [
      { id: "d5", name: "Smart Fan Plug", roomId: "lr", supremeType: "fan", capabilities: [{ kind: "fan" }, { kind: "onoff" }] },
    ];
    const body = buildDiscoveryResponse(devices) as {
      event: { payload: { endpoints: { endpointId: string; capabilities: { interface: string }[] }[] } };
    };
    expect(body.event.payload.endpoints).toHaveLength(1);
    const ifaces = body.event.payload.endpoints[0]!.capabilities.map((c) => c.interface);
    expect(ifaces).toContain("Alexa.PowerController");
  });
});
