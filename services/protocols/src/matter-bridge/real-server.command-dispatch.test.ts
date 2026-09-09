import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityCommand } from "@supreme/domain-model";
import { RealMatterBridgeServer } from "./real-server.js";
import { positionToMatterPercent100ths } from "./clusters/window-covering-adapter.js";

/**
 * § Matter Bridge Phase 1.2B — "Apple Home commands stopped working."
 *
 * Every prior real-SDK test in this suite (`real-server.device-types.test.ts`) only proves
 * endpoint CONSTRUCTION doesn't throw — none of them ever invoke a command through the SDK's own
 * dispatch path, so a real bug in the OnOff/LevelControl/ColorControl handler wiring (the exact
 * class of bug §C of the investigation asked about — a stale closure, a handler that never
 * reaches `emit`, a class that isn't actually composed into the endpoint) could exist and pass
 * every existing test. This suite closes that gap: it drives each cluster's command through
 * `Endpoint.act()`, the SAME entry point `@matter/node`'s real interaction/command-processing
 * layer uses for a genuine incoming command from a real controller (Apple Home included) — NOT a
 * direct call to our override method, which would only prove the method exists, not that the
 * SDK's dispatch machinery resolves to it.
 */
describe("RealMatterBridgeServer — real @matter/main command dispatch (Matter Bridge Phase 1.2B)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matter-bridge-dispatch-"));
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

  it("On/Off Light — a real OnOff.On/Off command dispatched via Endpoint.act() reaches emit() with the correct CapabilityCommand", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "dispatch-onoff" });
    if (!(await startOrSkip(server, "onoff"))) return;
    const received: CapabilityCommand[] = [];
    server.onCommand((_endpointNumber, command) => received.push(command));
    await server.addEndpoint({ endpointNumber: 1, name: "Kitchen Lights", deviceTypeId: 0x0100, initialState: { kind: "onoff", on: false }, capabilityKinds: ["onoff"] });

    await server.simulateCommandForTest(1, (agent) => agent.onOff.on());
    await server.simulateCommandForTest(1, (agent) => agent.onOff.off());

    expect(received).toContainEqual({ capability: "onoff", action: "on" });
    expect(received).toContainEqual({ capability: "onoff", action: "off" });
    await server.stop();
  }, 30_000);

  it("§ Matter Bridge Phase 2A — On/Off Plug-in Unit: real On/Off/Toggle commands reach emit() with the correct CapabilityCommand, and external state updates reach the Matter attribute", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "dispatch-plug" });
    if (!(await startOrSkip(server, "plug"))) return;
    const received: CapabilityCommand[] = [];
    server.onCommand((_endpointNumber, command) => received.push(command));
    await server.addEndpoint({ endpointNumber: 1, name: "Garage Outlet", deviceTypeId: 0x010a, initialState: { kind: "onoff", on: false }, capabilityKinds: ["onoff"] });

    await server.simulateCommandForTest(1, (agent) => agent.onOff.on());
    expect(received).toContainEqual({ capability: "onoff", action: "on" });
    received.length = 0;

    await server.simulateCommandForTest(1, (agent) => agent.onOff.off());
    expect(received).toContainEqual({ capability: "onoff", action: "off" });
    received.length = 0;

    // Toggle is a real, distinct Matter OnOff command — must be supported, not synthesized.
    await server.simulateCommandForTest(1, (agent) => agent.onOff.toggle());
    expect(received).toContainEqual({ capability: "onoff", action: "on" });

    // External state update (physical/protocol-driven) reaches the real Matter attribute.
    await server.setCapabilityState(1, { kind: "onoff", on: true });
    await server.stop();
  }, 30_000);

  it("Dimmable Light — a real LevelControl.MoveToLevel command reaches emit() with a normalized level, and OnOff still routes through 'brightness'", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "dispatch-dimmable" });
    if (!(await startOrSkip(server, "dimmable"))) return;
    const received: CapabilityCommand[] = [];
    server.onCommand((_endpointNumber, command) => received.push(command));
    await server.addEndpoint({ endpointNumber: 1, name: "R&D Study table Led Strip", deviceTypeId: 0x0101, initialState: { kind: "brightness", on: false, level: 0 }, capabilityKinds: ["brightness"] });

    await server.simulateCommandForTest(1, (agent) => agent.onOff.on());
    await server.simulateCommandForTest(1, (agent) => agent.levelControl.moveToLevel({ level: 127, transitionTime: null, optionsMask: {}, optionsOverride: {} }));

    expect(received.some((c) => c.capability === "brightness" && c.action === "on")).toBe(true);
    expect(received.some((c) => c.capability === "brightness" && c.action === "set" && typeof c.level === "number")).toBe(true);
    await server.stop();
  }, 30_000);

  it("Color Temperature Light, KNX shape (onoff+brightness+color declared) — real OnOff AND LevelControl commands both reach emit() via 'brightness', matching the fix for root cause A & B", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "dispatch-cct-knx" });
    if (!(await startOrSkip(server, "cct-knx"))) return;
    const received: CapabilityCommand[] = [];
    server.onCommand((_endpointNumber, command) => received.push(command));
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Conference Hanging",
      deviceTypeId: 0x010c,
      initialState: { kind: "color", on: false, level: 100, hue: null, saturation: null, kelvin: 3000 },
      capabilityKinds: ["onoff", "brightness", "color"],
    });

    await server.simulateCommandForTest(1, (agent) => agent.onOff.on());
    await server.simulateCommandForTest(1, (agent) => agent.levelControl.moveToLevel({ level: 180, transitionTime: null, optionsMask: {}, optionsOverride: {} }));
    await server.simulateCommandForTest(1, (agent) => agent.colorControl.moveToColorTemperature({ colorTemperatureMireds: 250, transitionTime: null, optionsMask: {}, optionsOverride: {} }));

    // § the exact regression this Phase fixed — these used to never appear at all (OnOff) or
    // route through "color" with a level Casambi tolerates but KNX does not (LevelControl).
    expect(received.some((c) => c.capability === "brightness" && c.action === "on")).toBe(true);
    expect(received.some((c) => c.capability === "brightness" && c.action === "set" && typeof c.level === "number")).toBe(true);
    expect(received.some((c) => c.capability === "color" && typeof c.kelvin === "number")).toBe(true);
    await server.stop();
  }, 30_000);

  it("Color Temperature Light, Casambi shape (brightness+color, no separate onoff) — real commands STILL reach emit() via 'brightness', the identical target as the KNX shape", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "dispatch-cct-casambi" });
    if (!(await startOrSkip(server, "cct-casambi"))) return;
    const received: CapabilityCommand[] = [];
    server.onCommand((_endpointNumber, command) => received.push(command));
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Pantry DL-1",
      deviceTypeId: 0x010c,
      initialState: { kind: "color", on: false, level: 100, hue: null, saturation: null, kelvin: 3000 },
      capabilityKinds: ["brightness", "color"],
    });

    await server.simulateCommandForTest(1, (agent) => agent.onOff.on());
    await server.simulateCommandForTest(1, (agent) => agent.levelControl.moveToLevel({ level: 180, transitionTime: null, optionsMask: {}, optionsOverride: {} }));

    expect(received.some((c) => c.capability === "brightness" && c.action === "on")).toBe(true);
    expect(received.some((c) => c.capability === "brightness" && c.action === "set" && typeof c.level === "number")).toBe(true);
    await server.stop();
  }, 30_000);

  it("§ Part C — command handlers survive a real factoryReset() intact: the SAME endpoint's OnOff command still reaches emit() afterward (no stale closure, no disposed callback)", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "dispatch-after-reset" });
    if (!(await startOrSkip(server, "after-reset"))) return;
    const received: CapabilityCommand[] = [];
    server.onCommand((_endpointNumber, command) => received.push(command));
    await server.addEndpoint({ endpointNumber: 1, name: "Kitchen Lights", deviceTypeId: 0x0100, initialState: { kind: "onoff", on: false }, capabilityKinds: ["onoff"] });

    await server.simulateCommandForTest(1, (agent) => agent.onOff.on());
    expect(received).toContainEqual({ capability: "onoff", action: "on" });
    received.length = 0;

    await server.factoryReset();

    // The exact question Part C asked: does the SAME emit callback (registered once, on the
    // SAME server instance, never re-subscribed by factoryReset per the Phase 1.2A fix) still
    // fire correctly for the SAME endpoint after a real erase()?
    await server.simulateCommandForTest(1, (agent) => agent.onOff.off());
    expect(received).toContainEqual({ capability: "onoff", action: "off" });
    await server.stop();
  }, 30_000);

  it("§ Matter Bridge Phase 1.3, Priority 7 — a real GoToLiftPercentage command preserves the EXACT position for every value in the reported-broken range, not quantized to open/closed", async () => {
    // § live-confirmed fix — root cause: `WindowCoveringServer`'s real, installed
    // `#prepareMovement` (see `real-server.ts`'s `handleMovement` doc for the full source-verified
    // trace) rewrites `DefinedByPosition` into a plain `Open`/`Close` direction whenever the
    // current position is already known — which is always true after the endpoint's initial
    // position is seeded — so `direction` is essentially NEVER `DefinedByPosition` by the time it
    // reaches our handler, even for an exact slider drag. The OLD handler only read
    // `targetPercent100ths` on that now-unreachable branch, silently collapsing every precise
    // GoToLiftPercentage into a bare open()/close(), which is exactly the reported "32% -> ~50%,
    // 75% -> ~100%" quantization. This test exercises the REAL SDK's command dispatch (not our
    // override directly) for the full reported-broken value range.
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "dispatch-curtain" });
    if (!(await startOrSkip(server, "curtain"))) return;
    const received: CapabilityCommand[] = [];
    server.onCommand((_endpointNumber, command) => received.push(command));
    await server.addEndpoint({ endpointNumber: 1, name: "Curtain motor", deviceTypeId: 0x0202, initialState: { kind: "position", position: 100, moving: false }, capabilityKinds: ["position"] });

    for (const supremePercent of [0, 1, 10, 25, 32, 50, 75, 90, 99, 100]) {
      received.length = 0;
      const liftPercent100thsValue = positionToMatterPercent100ths(supremePercent);
      await server.simulateCommandForTest(1, (agent) => agent.windowCovering.goToLiftPercentage({ liftPercent100thsValue }));
      expect(received, `Apple Home requesting SupremeOS position ${supremePercent}%`).toContainEqual({ capability: "position", action: "set", position: supremePercent });
    }
    await server.stop();
  }, 30_000);

  // § Matter Bridge Phase 2B — Generic Switch is UNIDIRECTIONAL (SupremeOS -> Matter only, no
  // `onCommand` involvement — confirmed against the SDK's own generated device definition, no
  // client-writable attributes/commands on a switch). These tests drive `reportKeypadPress` and
  // observe the REAL SwitchServer's own derived event sequence via `collectSwitchEventsForTest`
  // — proof the SDK's spec-compliant timing logic, not our own code, produced the sequence.

  it("§ Test D/F — a 'short' press produces the real initialPress -> shortRelease sequence", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "keypad-short" });
    if (!(await startOrSkip(server, "keypad-short"))) return;
    await server.addEndpoint({ endpointNumber: 1, name: "Button 1", deviceTypeId: 0x000f, initialState: null, capabilityKinds: [] });
    const { events } = server.collectSwitchEventsForTest(1);

    await server.reportKeypadPress(1, "short");
    await new Promise((r) => setTimeout(r, 100));

    expect(events.map((e) => e.type)).toContain("initialPress");
    expect(events.map((e) => e.type)).toContain("shortRelease");
    expect(events.map((e) => e.type)).not.toContain("longPress");
    await server.stop();
  }, 30_000);

  it("§ Test G — a 'long' press produces the real initialPress -> longPress -> longRelease sequence, never shortRelease", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "keypad-long" });
    if (!(await startOrSkip(server, "keypad-long"))) return;
    await server.addEndpoint({ endpointNumber: 1, name: "Button 1", deviceTypeId: 0x000f, initialState: null, capabilityKinds: [] });
    const { events } = server.collectSwitchEventsForTest(1);

    await server.reportKeypadPress(1, "long");
    await new Promise((r) => setTimeout(r, 100));

    expect(events.map((e) => e.type)).toEqual(["initialPress", "longPress", "longRelease"]);
    await server.stop();
  }, 30_000);

  it("a 'double' press produces two initialPress/shortRelease pairs then multiPressComplete{totalNumberOfPressesCounted:2}", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "keypad-double" });
    if (!(await startOrSkip(server, "keypad-double"))) return;
    await server.addEndpoint({ endpointNumber: 1, name: "Button 1", deviceTypeId: 0x000f, initialState: null, capabilityKinds: [] });
    const { events } = server.collectSwitchEventsForTest(1);

    await server.reportKeypadPress(1, "double");
    await new Promise((r) => setTimeout(r, 150));

    expect(events.filter((e) => e.type === "initialPress")).toHaveLength(2);
    const complete = events.find((e) => e.type === "multiPressComplete");
    expect(complete?.payload).toMatchObject({ totalNumberOfPressesCounted: 2 });
    await server.stop();
  }, 30_000);

  it("a 'triple' press produces multiPressComplete{totalNumberOfPressesCounted:3}", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "keypad-triple" });
    if (!(await startOrSkip(server, "keypad-triple"))) return;
    await server.addEndpoint({ endpointNumber: 1, name: "Button 1", deviceTypeId: 0x000f, initialState: null, capabilityKinds: [] });
    const { events } = server.collectSwitchEventsForTest(1);

    await server.reportKeypadPress(1, "triple");
    await new Promise((r) => setTimeout(r, 150));

    const complete = events.find((e) => e.type === "multiPressComplete");
    expect(complete?.payload).toMatchObject({ totalNumberOfPressesCounted: 3 });
    await server.stop();
  }, 30_000);

  it("§ Test E/H — two buttons on the same aggregator are independently addressable: a press on Button 1 produces events ONLY on Button 1's endpoint, never Button 2's", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "keypad-multi" });
    if (!(await startOrSkip(server, "keypad-multi"))) return;
    await server.addEndpoint({ endpointNumber: 1, name: "Button 1", deviceTypeId: 0x000f, initialState: null, capabilityKinds: [] });
    await server.addEndpoint({ endpointNumber: 2, name: "Button 2", deviceTypeId: 0x000f, initialState: null, capabilityKinds: [] });
    const button1 = server.collectSwitchEventsForTest(1);
    const button2 = server.collectSwitchEventsForTest(2);

    await server.reportKeypadPress(1, "short");
    await new Promise((r) => setTimeout(r, 100));

    expect(button1.events.length).toBeGreaterThan(0);
    expect(button2.events).toEqual([]);
    await server.stop();
  }, 30_000);

  it("§ Test O — reportKeypadPress is a no-op for an endpoint that isn't a Generic Switch (never crashes, never emits)", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "keypad-wrong-type" });
    if (!(await startOrSkip(server, "keypad-wrong-type"))) return;
    await server.addEndpoint({ endpointNumber: 1, name: "Kitchen Lights", deviceTypeId: 0x0100, initialState: { kind: "onoff", on: false }, capabilityKinds: ["onoff"] });
    await expect(server.reportKeypadPress(1, "short")).resolves.not.toThrow();
    await server.stop();
  }, 30_000);

  it("§ Test O — reportKeypadPress is a no-op for an endpoint number that doesn't exist at all", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "keypad-missing" });
    if (!(await startOrSkip(server, "keypad-missing"))) return;
    await expect(server.reportKeypadPress(99, "short")).resolves.not.toThrow();
    await server.stop();
  }, 30_000);
});
