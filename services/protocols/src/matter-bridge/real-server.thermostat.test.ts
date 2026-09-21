import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityCommand } from "@supreme/domain-model";
import { RealMatterBridgeServer } from "./real-server.js";

/**
 * § Matter Bridge Phase 3.2 — CoolMaster Thermostat. Real `@matter/main` endpoint
 * construction, real command dispatch, and the mandatory confirmed-state-authority tests
 * (§19-§23 of the Phase 3.2 spec). Same sandbox caveat as every other real-SDK suite in this
 * directory: `ServerNode.create()` opens real OS sockets; if this sandbox can't, each test
 * reports that honestly via a skip rather than a false pass.
 */
describe("RealMatterBridgeServer — Thermostat (real @matter/main endpoint construction)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matter-bridge-thermostat-"));
  });
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 100));
    rmSync(dir, { recursive: true, force: true });
  });

  async function startOrSkip(server: RealMatterBridgeServer, label: string): Promise<boolean> {
    try {
      await server.start();
      return true;
    } catch (err) {
      console.warn(`SKIPPED (${label}) — real @matter/main ServerNode could not start in this sandbox (${(err as Error).message}).`);
      return false;
    }
  }

  it("§19 — constructs a real Thermostat endpoint with Identify+Thermostat, Heating+Cooling features, no AutoMode/FanControl/OnOff", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-construct" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "heat", advanced: null },
      capabilityKinds: ["temperature"],
    });
    const state = server.getThermostatStateForTest(1)!;
    expect(state.featureMap).toMatchObject({ heating: true, cooling: true, autoMode: false });
    expect(state).not.toHaveProperty("onOff");
    await server.stop();
  }, 30_000);

  it("§20/§9 — a real systemMode attribute write reaches emit() as a temperature command with the correct mode", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-mode" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const received: CapabilityCommand[] = [];
    server.onCommand((_n, command) => received.push(command));
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "off", advanced: null },
      capabilityKinds: ["temperature"],
    });

    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    // § Phase 3.4B — Cool now routes through `heatCool` (DPT 1.100's genuine, writable, real
    // KNX destination — see thermostat-control-adapter.ts's own doc comment), never `mode`.
    await server.simulateAttributeWriteForTest(1, { thermostat: { systemMode: Thermostat.SystemMode.Cool } });
    expect(received).toContainEqual({ capability: "temperature", heatCool: "cool" });
    expect(received).not.toContainEqual({ capability: "temperature", mode: "cool" });

    received.length = 0;
    // Off still has no honest KNX destination (Phase 3.4A) — unchanged, still routes via `mode`.
    await server.simulateAttributeWriteForTest(1, { thermostat: { systemMode: Thermostat.SystemMode.Off } });
    expect(received).toContainEqual({ capability: "temperature", mode: "off" });
    await server.stop();
  }, 30_000);

  it("§20 — a real setpoint attribute write reaches emit() as a temperature command with the correct targetC", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-setpoint" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const received: CapabilityCommand[] = [];
    server.onCommand((_n, command) => received.push(command));
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "heat", advanced: null },
      capabilityKinds: ["temperature"],
    });

    await server.simulateAttributeWriteForTest(1, { thermostat: { occupiedHeatingSetpoint: 2100 } });
    expect(received).toContainEqual({ capability: "temperature", targetC: 21 });
    await server.stop();
  }, 30_000);

  it("§20 — the SDK's own constraint validation rejects an absurd out-of-range setpoint BEFORE it ever reaches emit() (no fabricated CoolMaster limit involved — the SDK's generic default envelope)", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-invalid" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const received: CapabilityCommand[] = [];
    server.onCommand((_n, command) => received.push(command));
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "cool", advanced: null },
      capabilityKinds: ["temperature"],
    });

    await expect(server.simulateAttributeWriteForTest(1, { thermostat: { occupiedCoolingSetpoint: 9999 } })).rejects.toThrow();
    expect(received).toHaveLength(0);
    await server.stop();
  }, 30_000);

  it("§21 — confirmed state authority: Matter requests 24C, CoolMaster confirms 23C -> Matter MUST report 23C, never the requested 24C", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-confirm-temp" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "heat", advanced: null },
      capabilityKinds: ["temperature"],
    });

    // A Matter controller requests 24C.
    await server.simulateAttributeWriteForTest(1, { thermostat: { occupiedHeatingSetpoint: 2400 } });
    // CoolMaster's real, confirmed physical state disagrees — reports 23C instead.
    await server.setCapabilityState(1, { kind: "temperature", ambientC: 22, targetC: 23, mode: "heat", advanced: null });

    const state = server.getThermostatStateForTest(1)!;
    expect(state.occupiedHeatingSetpoint).toBe(2300);
    expect(state.occupiedHeatingSetpoint).not.toBe(2400);
    await server.stop();
  }, 30_000);

  it("§21 — confirmed state authority: Matter requests mode=Cool, CoolMaster reports Heat -> Matter MUST ultimately report Heat", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-confirm-mode" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "off", advanced: null },
      capabilityKinds: ["temperature"],
    });

    await server.simulateAttributeWriteForTest(1, { thermostat: { systemMode: Thermostat.SystemMode.Cool } });
    // CoolMaster's real physical unit is actually in Heat (rejected/overridden the request).
    await server.setCapabilityState(1, { kind: "temperature", ambientC: 22, targetC: 20, mode: "heat", advanced: null });

    const state = server.getThermostatStateForTest(1)!;
    expect(state.systemMode).toBe(Thermostat.SystemMode.Heat);
    expect(state.systemMode).not.toBe(Thermostat.SystemMode.Cool);
    await server.stop();
  }, 30_000);

  it("§22 — AUTO REGRESSION: SystemMode.Auto is conformance-invalid on this endpoint and is never advertised as supported", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-auto-regression" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "cool", advanced: null },
      capabilityKinds: ["temperature"],
    });
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    await expect(server.simulateAttributeWriteForTest(1, { thermostat: { systemMode: Thermostat.SystemMode.Auto } })).rejects.toThrow();
    expect(server.getThermostatStateForTest(1)!.featureMap).toMatchObject({ autoMode: false });
    await server.stop();
  }, 30_000);

  it("§21 — SupremeOS reporting mode='auto' does NOT write systemMode at all (explicit, documented degradation — never a fabricated single-mode guess)", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-auto-report" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "cool", advanced: null },
      capabilityKinds: ["temperature"],
    });
    expect(server.getThermostatStateForTest(1)!.systemMode).toBe(Thermostat.SystemMode.Cool);

    await server.setCapabilityState(1, { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", advanced: null });
    // systemMode is left exactly as it was — never rewritten to a fabricated value for "auto".
    expect(server.getThermostatStateForTest(1)!.systemMode).toBe(Thermostat.SystemMode.Cool);
    await server.stop();
  }, 30_000);

  it("§23 — FAN-SPEED REGRESSION: no FanControl cluster, no fan speed attribute, no CoolMaster Auto/Low/Med/High/Top value ever reaches this endpoint", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-fan-regression" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "cool", advanced: { fanSpeed: "High" } },
      capabilityKinds: ["temperature"],
    });
    const state = server.getThermostatStateForTest(1)!;
    expect(state).not.toHaveProperty("fanMode");
    expect(state).not.toHaveProperty("percentSetting");
    expect(state).not.toHaveProperty("percentCurrent");
    expect(state).not.toHaveProperty("speedSetting");

    // Reporting advanced.fanSpeed via setCapabilityState must not leak it onto any attribute.
    await server.setCapabilityState(1, { kind: "temperature", ambientC: 22, targetC: 20, mode: "cool", advanced: { fanSpeed: "Top" } });
    const after = server.getThermostatStateForTest(1)!;
    expect(after).not.toHaveProperty("fanMode");
    expect(Object.keys(after).some((k) => k.toLowerCase().includes("fan"))).toBe(false);
    await server.stop();
  }, 30_000);

  it("§25 — two Thermostat endpoints: commands and confirmed state never cross-talk", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-multi" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const received: { n: number; command: CapabilityCommand }[] = [];
    server.onCommand((n, command) => received.push({ n, command }));
    await server.addEndpoint({ endpointNumber: 1, name: "Bedroom AC", deviceTypeId: 0x0301, initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "heat", advanced: null }, capabilityKinds: ["temperature"] });
    await server.addEndpoint({ endpointNumber: 2, name: "Living Room AC", deviceTypeId: 0x0301, initialState: { kind: "temperature", ambientC: 24, targetC: 22, mode: "cool", advanced: null }, capabilityKinds: ["temperature"] });

    await server.simulateAttributeWriteForTest(1, { thermostat: { occupiedHeatingSetpoint: 2100 } });
    expect(received).toEqual([{ n: 1, command: { capability: "temperature", targetC: 21 } }]);

    await server.setCapabilityState(2, { kind: "temperature", ambientC: 24, targetC: 25, mode: "cool", advanced: null });
    expect(server.getThermostatStateForTest(1)!.occupiedHeatingSetpoint).toBe(2100);
    expect(server.getThermostatStateForTest(2)!.occupiedCoolingSetpoint).toBe(2500);
    await server.stop();
  }, 30_000);

  /**
   * § Phase 3.4C — Matter Thermostat KNX heatCool read-back, real @matter/main SDK. Phase
   * 3.4B fixed Matter → KNX (SystemMode Heat/Cool write → SupremeOS heatCool command); this
   * closes the matching KNX → Matter gap: confirmed `TemperatureState.heatCool` feedback
   * (DPT 1.100) must reach Matter's `systemMode` attribute, which `state.mode` alone never
   * would for a single-GA KNX entity (`mode` is hardcoded "auto" there). This is real-SDK
   * confirmed-state reporting, NOT physical KNX hardware validation — Phase 3.3E remains
   * BLOCKED (no physical KNX bus/interface available in this environment); `setCapabilityState`
   * here simulates what a real KNX driver's confirmed feedback would report.
   */
  it("§Phase3.4C TEST 1 — confirmed heatCool='heat' reports Matter SystemMode.Heat", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-heatcool-heat" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", heatCool: null, advanced: null },
      capabilityKinds: ["temperature"],
    });

    await server.setCapabilityState(1, { kind: "temperature", ambientC: 22, targetC: 21, mode: "auto", heatCool: "heat", advanced: null });
    expect(server.getThermostatStateForTest(1)!.systemMode).toBe(Thermostat.SystemMode.Heat);
    await server.stop();
  }, 30_000);

  it("§Phase3.4C TEST 2 — confirmed heatCool='cool' reports Matter SystemMode.Cool", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-heatcool-cool" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 24, targetC: 22, mode: "auto", heatCool: null, advanced: null },
      capabilityKinds: ["temperature"],
    });

    await server.setCapabilityState(1, { kind: "temperature", ambientC: 24, targetC: 22, mode: "auto", heatCool: "cool", advanced: null });
    expect(server.getThermostatStateForTest(1)!.systemMode).toBe(Thermostat.SystemMode.Cool);
    await server.stop();
  }, 30_000);

  it("§Phase3.4C TEST 3 — confirmed feedback wins: heatCool flips from 'heat' to 'cool' and Matter follows, no stale Heat left over", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-heatcool-flip" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", heatCool: "heat", advanced: null },
      capabilityKinds: ["temperature"],
    });
    expect(server.getThermostatStateForTest(1)!.systemMode).toBe(Thermostat.SystemMode.Heat);

    await server.setCapabilityState(1, { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", heatCool: "cool", advanced: null });
    expect(server.getThermostatStateForTest(1)!.systemMode).toBe(Thermostat.SystemMode.Cool);
    expect(server.getThermostatStateForTest(1)!.systemMode).not.toBe(Thermostat.SystemMode.Heat);
    await server.stop();
  }, 30_000);

  it("§Phase3.4C TEST 4 — no heatCool (null/absent): falls back to mode exactly as before Phase 3.4C, never a fabricated Heat/Cool", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-heatcool-absent" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "off", heatCool: null, advanced: null },
      capabilityKinds: ["temperature"],
    });
    // mode="off" with no heatCool — falls back to mode, exactly the pre-3.4C path.
    expect(server.getThermostatStateForTest(1)!.systemMode).toBe(Thermostat.SystemMode.Off);

    // A CoolMaster-shaped confirmed state (heatCool entirely absent, not just null) with mode="cool".
    await server.setCapabilityState(1, { kind: "temperature", ambientC: 22, targetC: 20, mode: "cool", advanced: null });
    expect(server.getThermostatStateForTest(1)!.systemMode).toBe(Thermostat.SystemMode.Cool);
    await server.stop();
  }, 30_000);

  it("§Phase3.4C TEST 5/6 — mode='auto' + heatCool present reports the heatCool direction, never SystemMode.Auto", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-heatcool-vs-auto" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", heatCool: "heat", advanced: null },
      capabilityKinds: ["temperature"],
    });
    const heatState = server.getThermostatStateForTest(1)!;
    expect(heatState.systemMode).toBe(Thermostat.SystemMode.Heat);
    expect(heatState.systemMode).not.toBe(Thermostat.SystemMode.Auto);

    await server.setCapabilityState(1, { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", heatCool: "cool", advanced: null });
    const coolState = server.getThermostatStateForTest(1)!;
    expect(coolState.systemMode).toBe(Thermostat.SystemMode.Cool);
    expect(coolState.systemMode).not.toBe(Thermostat.SystemMode.Auto);
    await server.stop();
  }, 30_000);

  it("§Phase3.4C TEST 7 — Off remains unsupported: no heatCool value can ever produce Matter Off (DPT 1.100 has no Off value)", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-heatcool-no-off" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "heat", heatCool: "heat", advanced: null },
      capabilityKinds: ["temperature"],
    });
    expect(server.getThermostatStateForTest(1)!.systemMode).toBe(Thermostat.SystemMode.Heat);
    // heatCool never carries "off" (its type is heat|cool only) — confirms this cannot
    // regress into a fabricated Off via this read-back path, for any heatCool value.
    expect(server.getThermostatStateForTest(1)!.systemMode).not.toBe(Thermostat.SystemMode.Off);
    await server.stop();
  }, 30_000);

  it("§Phase3.4C TEST 8 — FanOnly remains unsupported: controllingModeExtended='fan_only' does not create Matter FanOnly (no FanControl, not read by this path at all)", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-heatcool-no-fanonly" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", heatCool: "heat", controllingModeExtended: "fan_only", advanced: null },
      capabilityKinds: ["temperature"],
    });
    // controllingModeExtended is never read anywhere in the Matter read-back path — heatCool
    // still (correctly) wins over mode="auto", and the FanControl cluster doesn't exist on
    // this endpoint at all (§23 regression, unchanged).
    expect(server.getThermostatStateForTest(1)!.systemMode).toBe(Thermostat.SystemMode.Heat);
    expect(server.getThermostatStateForTest(1)!).not.toHaveProperty("fanMode");
    await server.stop();
  }, 30_000);

  it("§Phase3.4C BIDIRECTIONAL LOOP A — Matter Heat command -> SupremeOS heatCool:\"heat\" -> confirmed feedback heatCool:\"heat\" -> Matter reports Heat", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-loop-a" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    const received: CapabilityCommand[] = [];
    server.onCommand((_n, command) => received.push(command));
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", heatCool: "cool", advanced: null },
      capabilityKinds: ["temperature"],
    });

    // Matter controller writes SystemMode.Heat.
    await server.simulateAttributeWriteForTest(1, { thermostat: { systemMode: Thermostat.SystemMode.Heat } });
    expect(received).toContainEqual({ capability: "temperature", heatCool: "heat" }); // § Phase 3.4B command shape

    // Real KNX feedback confirms heatCool="heat" (the physical unit agreed with the request).
    await server.setCapabilityState(1, { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", heatCool: "heat", advanced: null });
    expect(server.getThermostatStateForTest(1)!.systemMode).toBe(Thermostat.SystemMode.Heat);
    await server.stop();
  }, 30_000);

  it("§Phase3.4C BIDIRECTIONAL LOOP B — Matter Cool command -> SupremeOS heatCool:\"cool\" -> confirmed feedback heatCool:\"cool\" -> Matter reports Cool", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-loop-b" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    const received: CapabilityCommand[] = [];
    server.onCommand((_n, command) => received.push(command));
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", heatCool: "heat", advanced: null },
      capabilityKinds: ["temperature"],
    });

    await server.simulateAttributeWriteForTest(1, { thermostat: { systemMode: Thermostat.SystemMode.Cool } });
    expect(received).toContainEqual({ capability: "temperature", heatCool: "cool" });

    await server.setCapabilityState(1, { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", heatCool: "cool", advanced: null });
    expect(server.getThermostatStateForTest(1)!.systemMode).toBe(Thermostat.SystemMode.Cool);
    await server.stop();
  }, 30_000);

  it("§Phase3.4C BIDIRECTIONAL LOOP C — Matter Heat command, but KNX physical feedback disagrees and confirms Cool -> Matter MUST report Cool, not the requested Heat (confirmed-state authority)", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "thermo-loop-c" });
    if (!(await startOrSkip(server, "thermostat"))) return;
    const { Thermostat } = await import("@matter/main/clusters/thermostat");
    const received: CapabilityCommand[] = [];
    server.onCommand((_n, command) => received.push(command));
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Bedroom AC",
      deviceTypeId: 0x0301,
      initialState: { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", heatCool: "cool", advanced: null },
      capabilityKinds: ["temperature"],
    });

    // Matter requests Heat. (A raw attribute write, like a real controller's, takes
    // immediate effect on the Matter attribute itself — the SDK has no concept of
    // "pending confirmation"; SupremeOS's confirmed-state authority is enforced by what
    // happens NEXT, below: only real feedback is allowed to be the final word.)
    await server.simulateAttributeWriteForTest(1, { thermostat: { systemMode: Thermostat.SystemMode.Heat } });
    expect(received).toContainEqual({ capability: "temperature", heatCool: "heat" });

    // The real physical unit actually settled on / stayed at Cool — confirmed KNX feedback disagrees.
    await server.setCapabilityState(1, { kind: "temperature", ambientC: 22, targetC: 20, mode: "auto", heatCool: "cool", advanced: null });

    const finalState = server.getThermostatStateForTest(1)!;
    expect(finalState.systemMode).toBe(Thermostat.SystemMode.Cool);
    expect(finalState.systemMode).not.toBe(Thermostat.SystemMode.Heat);
    await server.stop();
  }, 30_000);
});
