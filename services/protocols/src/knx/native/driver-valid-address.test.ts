import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterEach, describe, expect, it } from "vitest";
import { KnxProtocolDriver } from "../../knx-driver.js";
import { formatGroupAddress } from "./address.js";
import { decodeDpt } from "./dpt.js";
import { createWorld, GA, type World } from "./simulator/test-world.js";
import type { BusTelegram } from "./simulator/virtual-bus.js";

/**
 * SIMULATOR ONLY. Companion to the 121-test driver parity run (docs/knx/knx-native-parity-evidence.md): the same driver behaviours, but with VALID group
 * addresses (main group ≤ 31, so nothing is aliased) and every status telegram travelling the whole path — virtual line → virtual gateway → UDP
 * → tunnel client → cEMI → telegram bus → DPT decode → driver — instead of being published straight into the bus. Nothing here is hardware evidence.
 */
let w: World;
let line: BusTelegram[];
const DEV = "device-valid-hvac" as DeviceId;
afterEach(async () => { for (const c of w.connections) { const p = c.disconnect(); await w.clock.advance(100); await p.catch(() => undefined); } await w.clock.advance(300_000); w.iface.shutdown(); expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 }); });

const G = { setpoint: "20/1/1", ambient: "20/1/2", opMode: "20/1/3", contrMode: "20/1/4", heatCool: "20/1/5", status: "20/1/6", setpoints: "20/1/7" };
async function rig(roles: Record<string, { address: string; dpt: string }> = {}, primary = G.setpoint, status = G.ambient) {
  w = createWorld();
  line = [];
  w.bus.monitor((t) => line.push(t));
  const conn = w.connection();
  const driver = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: async () => conn });
  const events: BackendStateEvent[] = [];
  driver.onState((e) => events.push(e));
  await driver.bind({ deviceId: DEV, capability: "temperature", address: primary, config: { statusAddress: status, dpt: "DPT9.001", hvacRoles: roles } });
  await w.until(driver.connect(), 2_000);
  return { conn, driver, events };
}
const ALL_ROLES = {
  operatingMode: { address: G.opMode, dpt: "DPT20.102" }, controllingModeExtended: { address: G.contrMode, dpt: "DPT20.105" }, heatCool: { address: G.heatCool, dpt: "DPT1.100" },
  status: { address: G.status, dpt: "DPT22.101" }, setpoints: { address: G.setpoints, dpt: "DPT222.100" },
};
const emit = async (ga: string, dpt: string, v: Parameters<World["sender"]["emit"]>[3]): Promise<void> => { w.sender.emit(w.bus, GA(ga), dpt, v); await w.clock.advance(20); };
const tunnelWrites = (): Array<{ ga: string; telegram: BusTelegram }> => line.filter((t) => t.service === "write" && t.source >= 0xff00).map((t) => ({ ga: formatGroupAddress(t.destination), telegram: t }));

describe("driver on the native connection with VALID group addresses, status over the real wire", () => {
  it("seven-GA HVAC entity (the 3.3C-5B 'U' scenario): every role merges into one state; commands reach exactly the right GAs with the right DPT; setpoints/status are never written", async () => {
    const { driver } = await rig(ALL_ROLES);
    await w.until(driver.command(DEV, { capability: "temperature", targetC: 21 }), 500);
    await w.until(driver.command(DEV, { capability: "temperature", heatCool: "heat" }), 500);
    await emit(G.ambient, "9.001", 20);
    await emit(G.contrMode, "20.105", 10);
    await emit(G.heatCool, "1.100", 1);
    await emit(G.status, "22.101", 1 << 11);
    await emit(G.setpoints, "222.100", { comfort: 21, standby: 19, economy: 17 });
    const writes = tunnelWrites();
    expect(writes.map((x) => x.ga)).toEqual([G.setpoint, G.heatCool]);
    expect(decodeDpt("9.001", writes[0]!.telegram.data!)).toBe(21);
    expect(decodeDpt("1.100", writes[1]!.telegram.data!)).toBe(true);   // DPT 1.100: 1 = heat (a one-bit value decodes as boolean)
    expect(writes.some((x) => x.ga === G.setpoints || x.ga === G.status)).toBe(false);
    expect(driver.getState(DEV, "temperature")).toMatchObject({
      ambientC: 20, controllingModeExtended: "free_cool", heatCool: "heat", status: { coolingDisabled: true }, setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    });
  });

  it("a command's value is NOT state: only the device's report on the status GA, delivered through the gateway, makes it observed", async () => {
    const { driver, events } = await rig(ALL_ROLES);
    w.actuator("1.1.10", G.heatCool, G.heatCool, "1.001");               // an unrelated actuator on the same line must not matter
    await w.until(driver.command(DEV, { capability: "temperature", heatCool: "cool" }), 500);
    expect(driver.getState(DEV, "temperature")).toBeNull();
    expect(events.every((e) => e.provenance === "commanded")).toBe(true);
    await emit(G.ambient, "9.001", 22);
    await emit(G.heatCool, "1.100", 1);                                    // the device reports "heat", disagreeing with the request
    expect(driver.getState(DEV, "temperature")).toMatchObject({ ambientC: 22, heatCool: "heat" });
  });

  it("bindings survive a real link outage and recovery (the fake's 'survives disconnect/reconnect' only swapped connection objects): no second tunnel, one delivery per telegram", async () => {
    const { driver, conn, events } = await rig(ALL_ROLES);
    await emit(G.ambient, "9.001", 19);
    const before = events.length;
    w.iface.reboot(30_000);
    await w.clock.advance(28_000);
    expect(driver.connectionState()).toBe("recovering");
    await w.clock.advance(60_000);
    expect(driver.connectionState()).toBe("connected");
    await emit(G.setpoints, "222.100", { comfort: 21, standby: 19, economy: 17 });
    await emit(G.ambient, "9.001", 23);
    expect(driver.getState(DEV, "temperature")).toMatchObject({ ambientC: 23, setpoints: { comfortC: 21 } });
    expect(events.length - before).toBe(2);                                // exactly two telegrams, exactly two events
    expect(conn.diagnostics().bus.activeSubscriptions).toBe(6);            // 1 primary + 5 roles, unchanged by the outage
    expect(w.connections).toHaveLength(1);
    expect(w.iface.counters.connects).toBe(2);
  });

  it("heatCool telegram carrying a 6-bit short value (the 'E' out-of-range case): dropped at the transport, counted, previous valid state kept", async () => {
    const { driver, conn } = await rig(ALL_ROLES);
    await emit(G.heatCool, "1.100", 1);
    await emit(G.ambient, "9.001", 21);
    expect(driver.getState(DEV, "temperature")).toMatchObject({ heatCool: "heat" });
    w.bus.transmit({ source: GA("0/0/1") & 0xffff, destination: GA(G.heatCool), service: "write", data: { kind: "short", value: 7 } });
    await w.clock.advance(20);
    expect(driver.getState(DEV, "temperature")).toMatchObject({ ambientC: 21, heatCool: "heat" });
    expect(conn.diagnostics().decodeFailures).toMatchObject({ bad_payload: 1 });   // NOT proven: that the driver would also ignore a decodable-but-reserved value (covered by the 121 tests via the fake)
  });

  it("duplicate GA, primary == operatingMode role (the 3.3D-FIX 'A' case): native fans out to BOTH observers; the 1-byte payload decodes only for the role, so no primary state is fabricated", async () => {
    const { driver, conn } = await rig({ operatingMode: { address: "20/2/1", dpt: "DPT20.102" } }, "20/2/1", "20/2/1");
    await emit("20/2/1", "20.102", 1);
    expect(driver.getState(DEV, "temperature")).toBeNull();
    expect(driver.getHvacRoleValue(DEV, "temperature", "operatingMode")).toBe(1);
    expect(conn.diagnostics().decodeFailures).toMatchObject({ bad_payload: 1 });  // the primary observer's DPT 9.001 refused the 1-byte payload
    // difference from the fake (documented, not hidden): a 2-byte 9.001 value on that GA reaches the primary too, because delivery is fan-out, not last-registered-wins
    await emit("20/2/1", "9.001", 20.5);
    expect(driver.getState(DEV, "temperature")).toMatchObject({ ambientC: 20.5 });
    expect(driver.getHvacRoleValue(DEV, "temperature", "operatingMode")).toBe(1);
  });

  it("what the 60 aliased tests could not show: an INVALID group address (main group > 31) is rejected visibly on the native path — inert observer in diagnostics, command fails not_sent", async () => {
    const { driver, conn } = await rig({}, "92/1/1", "92/1/2");
    expect(conn.diagnostics().rejectedObservers).toBe(1);
    expect(conn.diagnostics().lastRejectedObservers[0]).toMatchObject({ groupAddress: "92/1/2", dpt: "DPT9.001" });
    await expect(driver.command(DEV, { capability: "temperature", targetC: 21 })).rejects.toMatchObject({ code: "invalid_address", outcome: "not_sent" });
    expect(tunnelWrites()).toEqual([]);
    expect(driver.getState(DEV, "temperature")).toBeNull();
  });
});
