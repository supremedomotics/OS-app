import { describe, it, expect } from "vitest";
import { canStartKnxScan, type EtsSourceMode } from "./knx-discovery-workspace.js";

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
