import { describe, expect, it } from "vitest";
import { firstPerSingleCardKey } from "./single-card-drivers.js";

describe("firstPerSingleCardKey", () => {
  it("keeps one RTSP camera entry so Discover scans once, not once per camera", () => {
    const out = firstPerSingleCardKey([
      { key: "supreme-rtsp-camera", id: 1 }, { key: "supreme-rtsp-camera", id: 2 }, { key: "supreme-knx", id: 3 },
    ]);
    expect(out.map((d) => d.id)).toEqual([1, 3]);
  });
  it("leaves multi-instance drivers such as Casambi untouched", () => {
    expect(firstPerSingleCardKey([{ key: "supreme-casambi" }, { key: "supreme-casambi" }])).toHaveLength(2);
  });
});
