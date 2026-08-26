import { describe, expect, it } from "vitest";
import { buildSyncResponse } from "./google.js";
import type { HubDevice } from "./hub-router.js";

/** § Correctness Fix — a device whose capabilities produce zero real Google traits
 * must never be synced at all (never advertised-but-uncontrollable). */
describe("buildSyncResponse — never advertises an uncontrollable device", () => {
  it("syncs a device with a real, mapped capability", () => {
    const devices: HubDevice[] = [
      { id: "d1", name: "Lamp", roomId: "lr", supremeType: "light", capabilities: [{ kind: "onoff" }] },
    ];
    const body = buildSyncResponse("r1", "acct-1", devices) as { payload: { devices: { id: string }[] } };
    expect(body.payload.devices).toHaveLength(1);
    expect(body.payload.devices[0]?.id).toBe("d1");
  });

  it("omits a fan-only device — Google has no controllable trait for `fan`", () => {
    const devices: HubDevice[] = [
      { id: "d2", name: "Bathroom Fan", roomId: "bath", supremeType: "fan", capabilities: [{ kind: "fan" }] },
    ];
    const body = buildSyncResponse("r1", "acct-1", devices) as { payload: { devices: unknown[] } };
    expect(body.payload.devices).toEqual([]);
  });

  it("omits a sensor-only device — `sensor` is read-only and has no Google trait", () => {
    const devices: HubDevice[] = [
      { id: "d3", name: "Motion Sensor", roomId: "hall", supremeType: "sensor", capabilities: [{ kind: "sensor" }] },
    ];
    const body = buildSyncResponse("r1", "acct-1", devices) as { payload: { devices: unknown[] } };
    expect(body.payload.devices).toEqual([]);
  });

  it("omits a vacuum-only device — `vacuum` has no Google trait mapping", () => {
    const devices: HubDevice[] = [
      { id: "d4", name: "Robot Vacuum", roomId: "lr", supremeType: "vacuum", capabilities: [{ kind: "vacuum" }] },
    ];
    const body = buildSyncResponse("r1", "acct-1", devices) as { payload: { devices: unknown[] } };
    expect(body.payload.devices).toEqual([]);
  });

  it("still syncs a fan+onoff device — onoff genuinely gives Google a real control", () => {
    const devices: HubDevice[] = [
      { id: "d5", name: "Smart Fan Plug", roomId: "lr", supremeType: "fan", capabilities: [{ kind: "fan" }, { kind: "onoff" }] },
    ];
    const body = buildSyncResponse("r1", "acct-1", devices) as { payload: { devices: { id: string; traits: string[] }[] } };
    expect(body.payload.devices).toHaveLength(1);
    expect(body.payload.devices[0]?.traits).toContain("action.devices.traits.OnOff");
  });
});
