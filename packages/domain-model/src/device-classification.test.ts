import { describe, expect, it } from "vitest";
import { classifyDevice, inferRoomFromName } from "./device-classification.js";

describe("classifyDevice — Universal Device Intelligence Engine", () => {
  it("classifies from just a circuit name, even with only Switch/Status objects (the spec's minimal case)", () => {
    const c = classifyDevice({ circuitName: "Kitchen Ceiling Light", communicationObjectNames: ["Switch", "Status"] });
    expect(c.category).toBe("Lighting");
    expect(c.type).toBe("Ceiling Light");
    expect(c.canonicalDetailPage).toBe("lighting");
    expect(c.confidence).toBeGreaterThan(0);
    expect(c.reason).toContain("ceiling light");
  });

  it("classifies Spot Light, Pendant, Chandelier, Strip Light, Barrisol as Lighting with their specific type", () => {
    expect(classifyDevice({ circuitName: "Kitchen Spot Light" }).type).toBe("Spot Light");
    expect(classifyDevice({ circuitName: "Living Hanging Light" }).type).toBe("Pendant Light");
    expect(classifyDevice({ circuitName: "Dining Chandelier" }).type).toBe("Chandelier");
    expect(classifyDevice({ circuitName: "Kitchen Strip Light" }).type).toBe("LED Strip");
    expect(classifyDevice({ circuitName: "Kitchen Barrisol" }).type).toBe("Stretch Ceiling");
  });

  it("classifies locks as Security -> canonical security page", () => {
    const c = classifyDevice({ circuitName: "Main Door Lock" });
    expect(c.category).toBe("Security");
    expect(c.canonicalDetailPage).toBe("security");
  });

  it("classifies curtains/blinds/gates as Shading/Access -> curtains page", () => {
    expect(classifyDevice({ circuitName: "Kitchen Curtain" }).canonicalDetailPage).toBe("curtains");
    expect(classifyDevice({ circuitName: "Kitchen Blind" }).canonicalDetailPage).toBe("curtains");
    expect(classifyDevice({ circuitName: "Kitchen Gate" }).type).toBe("Gate");
  });

  it("classifies sprinklers, HVAC, energy meters, media, and sensors correctly", () => {
    expect(classifyDevice({ circuitName: "Garden Sprinkler" }).category).toBe("Water");
    expect(classifyDevice({ circuitName: "Living Room Thermostat" }).canonicalDetailPage).toBe("climate");
    expect(classifyDevice({ circuitName: "Main Energy Meter" }).canonicalDetailPage).toBe("energy");
    expect(classifyDevice({ circuitName: "Living Room TV" }).canonicalDetailPage).toBe("media");
    expect(classifyDevice({ circuitName: "Kitchen Motion Sensor" }).canonicalDetailPage).toBe("sensors");
  });

  it("prefers a more specific multi-word phrase over a shorter generic one", () => {
    const c = classifyDevice({ circuitName: "Living Room Roller Blind" });
    expect(c.type).toBe("Roller Blind"); // not the generic "Blind"
  });

  it("never lets a longer GENERIC word (switch/socket) outrank a shorter SPECIFIC one (gate/tv) by character length", () => {
    expect(classifyDevice({ circuitName: "Garden Gate Switch" }).type).toBe("Gate");
    expect(classifyDevice({ circuitName: "Living Room TV Switch" }).type).toBe("TV");
  });

  it("pools multiple sources instead of relying on only one", () => {
    const c = classifyDevice({ circuitName: "Unlabeled Circuit 4", functionalBlockTitles: ["Downlight"] });
    expect(c.type).toBe("Downlight");
    expect(c.reason).toContain("functional blocks");
  });

  it("user override always wins and is 100% confident, even for a name outside the vocabulary", () => {
    const known = classifyDevice({ userOverride: "Chandelier", circuitName: "Kitchen Switch" });
    expect(known.type).toBe("Chandelier");
    expect(known.confidence).toBe(100);

    const custom = classifyDevice({ userOverride: "Disco Ball", circuitName: "Kitchen Switch" });
    expect(custom.type).toBe("Disco Ball");
    expect(custom.confidence).toBe(100);
  });

  it("returns an honest unknown when no source matches anything", () => {
    const c = classifyDevice({ circuitName: "XYZ-001" });
    expect(c.type).toBe("Unknown");
    expect(c.confidence).toBe(0);
    expect(c.matchedKeyword).toBeNull();
  });

  it("returns an honest unknown when no signals are provided at all", () => {
    const c = classifyDevice({});
    expect(c.type).toBe("Unknown");
  });
});

describe("inferRoomFromName — Additional Enhancement (room inference from device name)", () => {
  it("extracts the room name preceding the matched device type", () => {
    expect(inferRoomFromName("Kitchen Ceiling Light", classifyDevice({ circuitName: "Kitchen Ceiling Light" }))).toBe("Kitchen");
    expect(inferRoomFromName("Living Hanging Light", classifyDevice({ circuitName: "Living Hanging Light" }))).toBe("Living");
    expect(inferRoomFromName("Master Bedroom Curtain", classifyDevice({ circuitName: "Master Bedroom Curtain" }))).toBe("Master Bedroom");
    expect(inferRoomFromName("Dining Chandelier", classifyDevice({ circuitName: "Dining Chandelier" }))).toBe("Dining");
    expect(inferRoomFromName("R&D Downlight", classifyDevice({ circuitName: "R&D Downlight" }))).toBe("R&D");
  });

  it("returns null (never a guess) when the type phrase is the whole name or nothing precedes it", () => {
    expect(inferRoomFromName("Chandelier", classifyDevice({ circuitName: "Chandelier" }))).toBeNull();
  });

  it("returns null when classification failed to match anything", () => {
    expect(inferRoomFromName("XYZ-001", classifyDevice({ circuitName: "XYZ-001" }))).toBeNull();
  });
});
