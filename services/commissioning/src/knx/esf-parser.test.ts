import { describe, expect, it } from "vitest";
import { looksLikeEsf, parseEsf } from "./esf-parser.js";

describe(".esf parser", () => {
  it("parses a tab-delimited ESF export with a header", () => {
    const esf = [
      `"Name"\t"Address"\t"Central"\t"Unfiltered"\t"Description"`,
      `"Living Room Light Switch"\t"1/1/1"\t"1"\t"0"\t"Ceiling downlight"`,
      `"Dining Hanging"\t"1/1/2"\t"1"\t"0"\t""`,
    ].join("\n");
    const model = parseEsf(esf);
    expect(model.groupAddresses.size).toBe(2);
    const first = [...model.groupAddresses.values()][0]!;
    expect(first.name).toBe("Living Room Light Switch");
    expect(first.address).toBe("1/1/1");
    expect(first.description).toBe("Ceiling downlight");
    expect(first.dpt).toBeNull(); // ESF carries no DPT — never fabricated
  });

  it("tolerates a header-less ESF with just name + address", () => {
    const esf = [`"Garage Door"\t"2/1/1"`, `"Pool Pump"\t"2/1/2"`].join("\n");
    const model = parseEsf(esf);
    expect(model.groupAddresses.size).toBe(2);
    expect([...model.groupAddresses.values()].map((g) => g.address)).toEqual(["2/1/1", "2/1/2"]);
  });

  it("detects the ESF shape vs. XML/CSV", () => {
    expect(looksLikeEsf(`"Name"\t"Address"`)).toBe(true);
    expect(looksLikeEsf(`<GroupAddress Address="1/1/1" />`)).toBe(false);
    expect(looksLikeEsf(`Group name;Address;DatapointType`)).toBe(false);
  });
});
