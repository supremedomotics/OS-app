import { describe, expect, it } from "vitest";
import { runKnxImport } from "./index.js";

/** Synthesize a large flat GA export: `count` devices × 2 addresses (switch + brightness)
 * spread across 20 rooms — mirrors a genuinely large commercial KNX installation. Every
 * address is derived from a single strictly-increasing 16-bit counter (main/middle/sub
 * bit-packed, same layout as `addressFromInt`) so all `deviceCount * 2` addresses are
 * guaranteed unique — real ETS group addresses always are, and since address is now the
 * synthetic id a real KNX project's parser falls back to (see ga-export-parser.ts), a
 * naive modulo-based generator here would silently collide addresses and undercount. */
function synthesizeLargeExport(deviceCount: number): string {
  const rooms = Array.from({ length: 20 }, (_, i) => `Room ${i}`);
  const lines: string[] = ["<GroupAddress-Export>"];
  let counter = 1;
  const nextAddress = () => {
    const n = counter++;
    return `${(n >> 11) & 0x1f}/${(n >> 8) & 0x7}/${n & 0xff}`;
  };
  for (let i = 0; i < deviceCount; i++) {
    const room = rooms[i % rooms.length];
    lines.push(`<GroupAddress Name="${room} Spot ${i} - Switch" Address="${nextAddress()}" DPTs="DPST-1-1" />`);
    lines.push(`<GroupAddress Name="${room} Spot ${i} - Brightness" Address="${nextAddress()}" DPTs="DPST-5-1" />`);
  }
  lines.push("</GroupAddress-Export>");
  return lines.join("\n");
}

describe("KNX import performance (§ Performance)", () => {
  it("imports 20,000+ group addresses / 5,000+ devices in well under 10 seconds", () => {
    const content = synthesizeLargeExport(10_000);
    const start = Date.now();
    const result = runKnxImport({ kind: "text", content }, { existingRoomNames: [] });
    const elapsedMs = Date.now() - start;

    expect(result.stats.groupAddressCount).toBeGreaterThanOrEqual(20_000);
    expect(result.devices.length).toBeGreaterThanOrEqual(5000);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);
});
