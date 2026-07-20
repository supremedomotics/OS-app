import { describe, expect, it } from "vitest";
import { newId } from "./ids.js";
import { MediaTopology, parseMediaTopology } from "./media-topology.js";

describe("MediaTopology", () => {
  it("accepts the worked example from the spec (installer-declared HDMI graph)", () => {
    const projectorId = newId("device");
    const parsed = MediaTopology.parse({
      connections: [
        { output: "hdmi1", label: "HDMI1", connectedLabel: "Apple TV" },
        { output: "hdmi2", label: "HDMI2", connectedLabel: "PlayStation 5" },
        { output: "hdmi3", label: "HDMI3", connectedLabel: "Blu-ray" },
        { output: "hdmiOut", label: "HDMI OUT", connectedDeviceId: projectorId, connectedLabel: "Sony Projector" },
        { output: "zone2", label: "Zone2", connectedLabel: "Conference Speakers" },
      ],
    });
    expect(parsed.connections).toHaveLength(5);
    expect(parsed.connections[3]?.connectedDeviceId).toBe(projectorId);
  });

  it("defaults to an empty connection list when omitted", () => {
    expect(MediaTopology.parse({})).toEqual({ connections: [] });
  });

  it("rejects a connection missing the required connectedLabel", () => {
    expect(() => MediaTopology.parse({ connections: [{ output: "hdmi1", label: "HDMI1" }] })).toThrow();
  });
});

describe("parseMediaTopology", () => {
  it("degrades malformed metadata to an empty topology instead of throwing", () => {
    expect(parseMediaTopology(undefined)).toEqual({ connections: [] });
    expect(parseMediaTopology(null)).toEqual({ connections: [] });
    expect(parseMediaTopology("not an object")).toEqual({ connections: [] });
    expect(parseMediaTopology({ connections: "not an array" })).toEqual({ connections: [] });
  });

  it("parses a valid blob straight through", () => {
    const result = parseMediaTopology({ connections: [{ output: "hdmi1", label: "HDMI1", connectedLabel: "Apple TV" }] });
    expect(result.connections).toHaveLength(1);
  });
});
