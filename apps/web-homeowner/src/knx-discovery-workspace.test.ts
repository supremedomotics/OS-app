import { describe, it, expect } from "vitest";
import { canStartKnxScan, capabilityDisplayLabels, type EtsSourceMode } from "./knx-discovery-workspace.js";

// § The old "reading/encoding a huge file" race window this used to guard against is
// gone: a `.knxproj` now travels as a real multipart file upload (no client-side
// read-then-base64-encode step at all — see api.ts's knxDiscoveryQueueJobStart), so
// the gate only needs to track whether a scan is already running.
describe("canStartKnxScan", () => {
  it("allows starting a scan when idle", () => {
    expect(canStartKnxScan("idle")).toBe(true);
  });

  it("allows starting a new scan after a previous one completed", () => {
    expect(canStartKnxScan("done")).toBe(true);
  });

  it("allows starting a new scan after a previous one errored", () => {
    expect(canStartKnxScan("error")).toBe(true);
  });

  it("blocks starting a scan while one is already running", () => {
    expect(canStartKnxScan("scanning")).toBe(false);
  });
});

// § UX fix — an ETS project file and a pasted group-address export are mutually exclusive
// alternatives (not "use both at once"); the picker must always resolve to exactly one of
// the three states below, never allow both inputs simultaneously. This is a compile-time
// exhaustiveness guard (no component test harness in this app — see canStartKnxScan's own
// note) so a future fourth mode can't be added to the type without every switch over it
// (the render branches in knx-discovery-workspace.tsx) being forced to handle it.
describe("EtsSourceMode", () => {
  it("is exactly one of: no source chosen yet, a project file, or pasted text", () => {
    function label(mode: EtsSourceMode): string {
      switch (mode) {
        case null: return "none";
        case "project": return "project";
        case "pasted": return "pasted";
      }
    }
    expect(label(null)).toBe("none");
    expect(label("project")).toBe("project");
    expect(label("pasted")).toBe("pasted");
  });
});

// § P0-C (Pass 28) — the review card must show "CCT"/"RGB" instead of the ambiguous
// generic "color" the moment the server-computed plan reveals it (§ colorModesFromDpt,
// services/protocols/src/knx/binding-engine.ts) — this reads ONLY that server-sent
// evidence, never re-derives anything from a device/GA name itself.
describe("capabilityDisplayLabels", () => {
  it("TEST 6: CCT-only — labels the color capability 'cct', not 'rgb'", () => {
    const labels = capabilityDisplayLabels(
      ["onoff", "brightness", "color"],
      [{ capability: "color", config: { colorModes: { rgb: false, cct: true } } }],
    );
    expect(labels).toEqual(["onoff", "brightness", "cct"]);
    expect(labels).not.toContain("rgb");
  });

  it("TEST 7: RGB-only — labels the color capability 'rgb', not 'cct'", () => {
    const labels = capabilityDisplayLabels(
      ["onoff", "brightness", "color"],
      [{ capability: "color", config: { colorModes: { rgb: true, cct: false } } }],
    );
    expect(labels).toEqual(["onoff", "brightness", "rgb"]);
    expect(labels).not.toContain("cct");
  });

  it("RGB+CCT — labels the color capability 'rgb+cct'", () => {
    const labels = capabilityDisplayLabels(
      ["onoff", "brightness", "color"],
      [{ capability: "color", config: { colorModes: { rgb: true, cct: true } } }],
    );
    expect(labels).toEqual(["onoff", "brightness", "rgb+cct"]);
  });

  it("TEST 8: unknown — no plan resolved colorModes, falls back to the plain 'color' label rather than guessing", () => {
    const labels = capabilityDisplayLabels(["onoff", "brightness", "color"], [{ capability: "color", config: {} }]);
    expect(labels).toEqual(["onoff", "brightness", "color"]);
  });

  it("no color capability at all — every label passes through unchanged", () => {
    expect(capabilityDisplayLabels(["onoff", "brightness"], [])).toEqual(["onoff", "brightness"]);
  });
});
