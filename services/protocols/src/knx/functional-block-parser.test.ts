import { describe, expect, it } from "vitest";
import { parseFunctionalBlocks } from "./functional-block-parser.js";

describe("parseFunctionalBlocks", () => {
  it("parses a real RFC 6690 Link-Format body into functional blocks", () => {
    const body = '</fb/1/onoff>;rt="urn:knx:fb.onoff";if="if.a";title="Kitchen Light Switch";ct=60,</fb/1/status>;rt="urn:knx:fb.status";if="if.s";title="Kitchen Light Status"';
    const parsed = parseFunctionalBlocks(body);
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]).toMatchObject({ href: "/fb/1/onoff", resourceTypes: ["urn:knx:fb.onoff"], interfaces: ["if.a"], title: "Kitchen Light Switch", writable: true });
    expect(parsed.blocks[1]).toMatchObject({ href: "/fb/1/status", interfaces: ["if.s"], feedbackOnly: true, writable: false });
    expect(parsed.writableHrefs).toEqual(["/fb/1/onoff"]);
    expect(parsed.feedbackHrefs).toEqual(["/fb/1/status"]);
  });

  it("does not split commas inside quoted attribute values", () => {
    const body = '</fb/1>;rt="urn:knx:fb.a urn:knx:fb.b";title="Living, Room Light"';
    const parsed = parseFunctionalBlocks(body);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.title).toBe("Living, Room Light");
    expect(parsed.blocks[0]?.resourceTypes).toEqual(["urn:knx:fb.a", "urn:knx:fb.b"]);
  });

  it("returns an empty result for an empty body rather than fabricating a block", () => {
    expect(parseFunctionalBlocks("")).toEqual({ blocks: [], readableHrefs: [], writableHrefs: [], feedbackHrefs: [] });
  });
});
