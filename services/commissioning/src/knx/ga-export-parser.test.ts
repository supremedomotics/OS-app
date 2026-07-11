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

  it("parses ETS5/6's native 'Export Group Addresses' CSV — Main/Middle/Sub columns, group " +
    "names printed once on a non-leaf summary row then left blank on every following row", () => {
    const csv = [
      `"Main";"Middle";"Sub";"Address";"Central";"Unfiltered";"Description";"DatapointType"`,
      `"All Lights";"Master Control";"";"0/-/-";"";"";"";""`,
      `"";"";"SW";"0/0/1";"";"";"";"DPST-1-1"`,
      `"";"";"SW Status";"0/0/2";"";"";"";"DPST-1-1"`,
      `"";"";"Dimm";"0/0/3";"";"";"";"DPST-1-7"`,
    ].join("\n");
    const model = parseGaExport(csv);
    // The "0/-/-" summary row isn't a leaf group address — only the three real ones parse.
    expect(model.groupAddresses.size).toBe(3);
    const sw = model.groupAddresses.get("ga:0/0/1")!;
    expect(sw).toMatchObject({ name: "SW", mainGroup: "All Lights", middleGroup: "Master Control", dpt: "1.001" });
    const status = model.groupAddresses.get("ga:0/0/2")!;
    expect(status).toMatchObject({ name: "SW Status", mainGroup: "All Lights", middleGroup: "Master Control" });
    const dimm = model.groupAddresses.get("ga:0/0/3")!;
    expect(dimm).toMatchObject({ name: "Dimm", mainGroup: "All Lights", middleGroup: "Master Control", dpt: "1.007" });
  });
});
