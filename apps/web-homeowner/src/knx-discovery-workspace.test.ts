import { describe, it, expect } from "vitest";
import { canStartKnxScan, type EtsSourceMode } from "./knx-discovery-workspace.js";

// § Live-reproduced bug regression (Mode A — fast empty scan): the Scan/Discover
// button and file input must stay disabled for the ENTIRE window between a user
// picking an ETS project file and its async-read + base64-encode finishing, not
// just while a scan is already running — otherwise a click in that window silently
// sends no `ets` source at all, falling through to a bare live KNX-IoT scan that
// returns all-zeros in ~3000ms (KnxIotProvider's own discovery timeout) even though
// the UI already shows "Selected: <file>.knxproj".
describe("canStartKnxScan", () => {
  it("allows starting a scan when idle and no file is being read", () => {
    expect(canStartKnxScan("idle", false)).toBe(true);
  });

  it("allows starting a new scan after a previous one completed", () => {
    expect(canStartKnxScan("done", false)).toBe(true);
  });

  it("blocks starting a scan while one is already running", () => {
    expect(canStartKnxScan("scanning", false)).toBe(false);
  });

  it("blocks starting a scan while the selected ETS file is still being read/encoded", () => {
    expect(canStartKnxScan("idle", true)).toBe(false);
    expect(canStartKnxScan("done", true)).toBe(false);
    expect(canStartKnxScan("error", true)).toBe(false);
  });

  it("blocks when both a scan is running and a file read is in flight", () => {
    expect(canStartKnxScan("scanning", true)).toBe(false);
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
