import { describe, expect, it } from "vitest";
import { humanizeName, humanizeSegment, splitNameSegments } from "./name-cleanup.js";

describe("name cleanup", () => {
  it("expands common ETS abbreviations", () => {
    expect(humanizeSegment("MB")).toBe("Master Bedroom");
    expect(humanizeSegment("LR")).toBe("Living Room");
    expect(humanizeSegment("Curt")).toBe("Curtain");
    expect(humanizeSegment("Sp1")).toBe("Spot 1");
  });

  it("splits trailing digits from an abbreviation before expanding", () => {
    expect(humanizeSegment("BR2")).toBe("Bedroom 2");
    expect(humanizeSegment("Sp1")).toBe("Spot 1");
  });

  it("leaves already-clear words and deliberate acronyms alone", () => {
    expect(humanizeSegment("Living Spot 1")).toBe("Living Spot 1");
    expect(humanizeSegment("AC Unit")).toBe("AC Unit");
  });

  it("splits an ETS hierarchical name on its separators", () => {
    expect(splitNameSegments("Master Bedroom - Sheer Curtains - Position")).toEqual([
      "Master Bedroom",
      "Sheer Curtains",
      "Position",
    ]);
    expect(splitNameSegments("Dining Hanging")).toEqual(["Dining Hanging"]);
  });

  it("humanizes a full multi-segment name", () => {
    expect(humanizeName("MB - Curt - Sw")).toBe("Master Bedroom — Curtain — Switch");
  });
});
