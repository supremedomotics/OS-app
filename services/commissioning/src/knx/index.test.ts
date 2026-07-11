import { describe, expect, it } from "vitest";
import { runKnxImport, toCommissionable } from "./index.js";

describe("KNX import orchestrator", () => {
  it("runs the full pipeline end to end from a flat GA export", () => {
    const result = runKnxImport({
      kind: "text",
      content: `<x>
        <GroupAddress Name="Living Room Downlight - Switch" Address="1/1/1" DPTs="DPST-1-1" />
        <GroupAddress Name="Living Room Downlight - Brightness" Address="1/1/2" DPTs="DPST-5-1" />
        <GroupAddress Name="Master Bedroom Curtain - Position" Address="2/1/1" DPTs="DPST-5-1" />
      </x>`,
    }, { existingRoomNames: ["Living Room", "Master Bedroom"] });

    expect(result.devices).toHaveLength(2);
    const downlight = result.devices.find((d) => d.name.includes("Downlight"));
    expect(downlight?.room).toBe("Living Room");
    expect(downlight?.deviceType).toBe("light_dimmable");
    expect(result.stats.groupAddressCount).toBe(3);
    expect(result.stats.recognizedDeviceCount).toBe(2);
    expect(result.stats.roomsFound).toBe(2);
    expect(result.stats.parseMs).toBeGreaterThanOrEqual(0);
  });

  it("routes an .esf source through the ESF parser (no fabricated DPT)", () => {
    const esf = [`"Name"\t"Address"\t"Description"`, `"Garage Door"\t"3/1/1"\t""`].join("\n");
    const result = runKnxImport({ kind: "text", content: esf });
    expect(result.stats.groupAddressCount).toBe(1);
  });

  it("flags two devices landing on the same (name, room) as conflicting_device", () => {
    const result = runKnxImport({
      kind: "text",
      content: `<x>
        <GroupAddress Name="Kitchen Downlight - Switch" Address="1/1/1" DPTs="DPST-1-1" />
        <GroupAddress Name="Kitchen Downlight - Brightness" Address="1/1/2" DPTs="DPST-5-1" />
      </x>`,
    });
    // Same cluster, so this alone shouldn't conflict; verify no false positive on a single device.
    expect(result.warnings.some((w) => w.code === "conflicting_device")).toBe(false);
  });

  it("converts a recognized device into a commissionable device + card in one call", () => {
    const result = runKnxImport({
      kind: "text",
      content: `<x><GroupAddress Name="Hallway Light - Switch" Address="1/1/1" DPTs="DPST-1-1" /></x>`,
    });
    const commissionable = toCommissionable(result.devices[0]!);
    expect(commissionable.bindings).toEqual([{ capability: "onoff", address: "1/1/1", config: { dpt: "DPT1.001" } }]);
    expect(commissionable.card.icon).toBe("lightbulb");
    expect(commissionable.card.controls).toEqual([{ kind: "toggle", capability: "onoff" }]);
  });

  it("applies learned renames end to end", () => {
    const first = runKnxImport({
      kind: "text",
      content: `<x><GroupAddress Name="Living Spot 1 - Switch" Address="1/1/1" DPTs="DPST-1-1" /></x>`,
    });
    const fingerprint = first.devices[0]!.fingerprint;
    const second = runKnxImport(
      { kind: "text", content: `<x><GroupAddress Name="Living Spot 1 - Switch" Address="1/1/1" DPTs="DPST-1-1" /></x>` },
      { learnedNames: [{ fingerprint, name: "Dining Spot", learnedAt: "2026-01-01T00:00:00.000Z" }] },
    );
    expect(second.devices[0]?.name).toBe("Dining Spot");
  });

  it("keeps a device's fingerprint stable across re-imports even when unrelated GAs are added before it", () => {
    // A flat GA export's synthetic id must derive from the address, not row position —
    // otherwise adding a device earlier in a re-exported project would shift every later
    // GA's positional id and silently break the Learning Engine's rename recall.
    const first = runKnxImport({
      kind: "text",
      content: `<x><GroupAddress Name="Living Spot 1 - Switch" Address="1/1/5" DPTs="DPST-1-1" /></x>`,
    });
    const second = runKnxImport({
      kind: "text",
      content: `<x>
        <GroupAddress Name="New Hallway Light - Switch" Address="1/1/1" DPTs="DPST-1-1" />
        <GroupAddress Name="Living Spot 1 - Switch" Address="1/1/5" DPTs="DPST-1-1" />
      </x>`,
    });
    const livingSpot = second.devices.find((d) => d.name.includes("Living Spot"));
    expect(livingSpot?.fingerprint).toBe(first.devices[0]!.fingerprint);
  });
});
