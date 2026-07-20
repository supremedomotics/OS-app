import { describe, expect, it } from "vitest";
import type { Device, Scene } from "@supreme/domain-model";
import type { AutomationView } from "./api.js";
import {
  actionLabel,
  condTitle,
  defaultNode,
  nodeGlyph,
  nodeSummary,
  triggerTitle,
  type EditorNode,
} from "./automations.js";

/**
 * Pure-function coverage for the Automation Editor's node-authoring/display helpers
 * (§ Automation Editor Production Hardening). Previously this file had zero test
 * coverage; these functions need no DOM/React rendering (apps/web-homeowner has no
 * component-test infrastructure — see docs/architecture/Automation-Editor-Production-
 * Hardening-Report.md's test-coverage audit for why component tests are out of scope
 * for this pass), so they're testable exactly like any other pure TypeScript module.
 */

const device = (overrides: Partial<Device> = {}): Device =>
  ({ id: "device-1", name: "Living Room Lamp", ...overrides }) as Device;
const scene = (overrides: Partial<Scene> = {}): Scene =>
  ({ id: "scene-1", name: "Movie Night", ...overrides }) as Scene;

describe("defaultNode — one default shape per editor node type", () => {
  it("produces the exhaustive, DSL-compatible default for every EditorNode type", () => {
    expect(defaultNode("time")).toEqual({ type: "time", at: "07:00", days: [] });
    expect(defaultNode("device_state")).toEqual({
      type: "device_state",
      deviceId: null,
      capability: "onoff",
      field: "on",
      op: "eq",
      value: true,
    });
    expect(defaultNode("device_command")).toEqual({
      type: "device_command",
      deviceId: null,
      command: { capability: "onoff", action: "on" },
    });
    expect(defaultNode("scene_activate")).toEqual({ type: "scene_activate", sceneId: null });
    expect(defaultNode("notify")).toEqual({ type: "notify", level: "info", title: "Alert", body: "" });
    expect(defaultNode("delay")).toEqual({ type: "delay", ms: 5000 });
  });
});

describe("nodeSummary — human-readable node labels for the canvas", () => {
  const devices = [device()];
  const scenes = [scene()];

  it("summarizes every node type", () => {
    expect(nodeSummary({ type: "time", at: "07:00", days: [] }, devices, scenes)).toBe("Time · 07:00");
    expect(nodeSummary({ type: "delay", ms: 30_000 }, devices, scenes)).toBe("Delay · 30s");
    expect(nodeSummary({ type: "notify", level: "info", title: "Door open", body: "" }, devices, scenes)).toBe(
      "Notify · Door open",
    );
    expect(nodeSummary({ type: "scene_activate", sceneId: "scene-1" }, devices, scenes)).toBe("Scene · Movie Night");
    expect(
      nodeSummary(
        { type: "device_command", deviceId: "device-1", command: { capability: "onoff", action: "on" } },
        devices,
        scenes,
      ),
    ).toBe("Living Room Lamp → on");
    expect(
      nodeSummary(
        { type: "device_state", deviceId: "device-1", capability: "onoff", field: "on", op: "eq", value: true },
        devices,
        scenes,
      ),
    ).toBe("Living Room Lamp is on");
  });

  it("falls back to a generic label when a device/scene reference doesn't resolve (deleted device/scene)", () => {
    expect(
      nodeSummary(
        { type: "device_command", deviceId: "device-does-not-exist", command: { capability: "onoff", action: "off" } },
        devices,
        scenes,
      ),
    ).toBe("device → off");
    expect(nodeSummary({ type: "scene_activate", sceneId: "scene-does-not-exist" }, devices, scenes)).toBe("Scene · …");
    expect(nodeSummary({ type: "device_command", deviceId: null, command: { capability: "onoff", action: "on" } }, devices, scenes)).toBe(
      "device → on",
    );
  });

  it("is exhaustive over every EditorNode variant — a new variant without a case fails to typecheck, not just at runtime", () => {
    // Compile-time guarantee: this function assigns every EditorNode branch's return
    // to `string` with no `default` case, so TypeScript itself enforces exhaustiveness.
    const allTypes: EditorNode["type"][] = ["time", "device_state", "device_command", "scene_activate", "notify", "delay"];
    for (const type of allTypes) {
      expect(() => nodeSummary(defaultNode(type), devices, scenes)).not.toThrow();
    }
  });
});

describe("nodeGlyph / actionLabel / condTitle — display glyphs and labels", () => {
  it("maps every known node/trigger/condition type to a real glyph, falling back to a bullet for anything unrecognized", () => {
    expect(nodeGlyph("device_state")).toBe("⊙");
    expect(nodeGlyph("time")).toBe("◷");
    expect(nodeGlyph("interval")).toBe("↻");
    expect(nodeGlyph("time_window")).toBe("▭");
    expect(nodeGlyph("device_command")).toBe("⤳");
    expect(nodeGlyph("scene_activate")).toBe("✦");
    expect(nodeGlyph("notify")).toBe("🔔");
    expect(nodeGlyph("delay")).toBe("⏱");
    expect(nodeGlyph("nonexistent-type")).toBe("•");
  });

  it("maps every action type to a human label, falling back to 'Action'", () => {
    expect(actionLabel("device_command")).toBe("Adjust Device");
    expect(actionLabel("scene_activate")).toBe("Run Scene");
    expect(actionLabel("notify")).toBe("Notify");
    expect(actionLabel("delay")).toBe("Delay");
    expect(actionLabel(undefined)).toBe("Action");
    expect(actionLabel("nonexistent-type")).toBe("Action");
  });

  it("labels time_window distinctly from every other condition (currently only device_state)", () => {
    expect(condTitle("time_window")).toBe("Time window");
    expect(condTitle("device_state")).toBe("Device state");
    expect(condTitle("anything-else")).toBe("Device state");
  });
});

describe("triggerTitle — Canvas view's read-only trigger summary", () => {
  it("summarizes a time trigger, an interval trigger, and a device_state (sensor) trigger", () => {
    const time: AutomationView["triggers"][number] = { type: "time", at: "22:00" };
    const interval: AutomationView["triggers"][number] = { type: "interval", everyMinutes: 15 };
    const sensor: AutomationView["triggers"][number] = { type: "device_state", capability: "onoff", field: "on" };
    expect(triggerTitle(time)).toBe("Time · 22:00");
    expect(triggerTitle(interval)).toBe("Every 15m");
    expect(triggerTitle(sensor)).toBe("Sensor · onoff on");
  });

  it("tolerates a device_state trigger missing capability/field (never fabricates a placeholder value)", () => {
    const bare: AutomationView["triggers"][number] = { type: "device_state" };
    expect(triggerTitle(bare)).toBe("Sensor ·");
  });
});
