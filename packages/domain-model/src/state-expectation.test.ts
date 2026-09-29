import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectationOf } from "./state-expectation.js";

interface Case {
  capability: string;
  command: Record<string, unknown>;
  verifiable: boolean;
  states: { state: Record<string, unknown>; matches: boolean }[];
}
const fixture = JSON.parse(readFileSync(new URL("../fixtures/state-expectation.json", import.meta.url), "utf8")) as { cases: Case[] };

describe("expectationOf — shared conformance fixture", () => {
  for (const c of fixture.cases) {
    it(`${c.capability} ${JSON.stringify(c.command)}`, () => {
      const e = expectationOf(c.capability, c.command);
      if (!c.verifiable) {
        expect(e).toBeNull();
        return;
      }
      expect(e).not.toBeNull();
      for (const s of c.states) expect(e!.matches(s.state), JSON.stringify(s.state)).toBe(s.matches);
    });
  }
});
