import { describe, expect, it } from "vitest";
import { collapseSingleCardKeys } from "./extensions.js";
import type { DriverEntry } from "./api.js";

const d = (key: string, installed: boolean): DriverEntry => ({ key, installed, name: key } as unknown as DriverEntry);

describe("collapseSingleCardKeys", () => {
  it("collapses many RTSP camera instances into one card and counts the installed ones", () => {
    const out = collapseSingleCardKeys([
      d("supreme-rtsp-camera", true), d("supreme-rtsp-camera", true), d("supreme-rtsp-camera", true),
      d("supreme-knx", true),
    ]);
    expect(out.map((o) => o.entry.key)).toEqual(["supreme-rtsp-camera", "supreme-knx"]);
    expect(out[0]!.instances).toBe(3);
  });
  it("prefers an installed entry over an uninstalled one for the card", () => {
    const out = collapseSingleCardKeys([d("supreme-rtsp-camera", false), d("supreme-rtsp-camera", true)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.entry.installed).toBe(true);
    expect(out[0]!.instances).toBe(1);
  });
  it("leaves other drivers (e.g. multi-network Casambi) untouched", () => {
    const out = collapseSingleCardKeys([d("supreme-casambi", true), d("supreme-casambi", true)]);
    expect(out).toHaveLength(2);
  });
});
