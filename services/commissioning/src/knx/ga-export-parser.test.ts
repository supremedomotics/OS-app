import { describe, expect, it } from "vitest";
import { parseGaExport } from "./ga-export-parser.js";

describe("flat GA export parser", () => {
  it("parses the ETS XML group-address export with nested Main/Middle groups", () => {
    const xml = `<GroupAddress-Export>
      <GroupRange Name="Lighting">
        <GroupRange Name="Switching">
          <GroupAddress Name="Living Spot-1" Address="1/1/1" DPTs="DPST-1-1" />
        </GroupRange>
      </GroupRange>
    </GroupAddress-Export>`;
    const model = parseGaExport(xml);
    expect(model.groupAddresses.size).toBe(1);
    const ga = [...model.groupAddresses.values()][0]!;
    expect(ga).toMatchObject({ address: "1/1/1", name: "Living Spot-1", dpt: "1.001", mainGroup: "Lighting", middleGroup: "Switching" });
  });

  it("parses the CSV export with Main/Middle columns", () => {
    const csv = [
      `"Main";"Middle";"Group name";"Address";"DatapointType"`,
      `"Lighting";"Switching";"Living Spot-1";"1/1/1";"DPST-1-1"`,
    ].join("\n");
    const model = parseGaExport(csv);
    const ga = [...model.groupAddresses.values()][0]!;
    expect(ga).toMatchObject({ mainGroup: "Lighting", middleGroup: "Switching", address: "1/1/1", dpt: "1.001" });
  });
});
