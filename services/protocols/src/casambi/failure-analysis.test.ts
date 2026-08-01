import { describe, expect, it } from "vitest";
import { buildFailureAnalysisReport, formatFailureAnalysisReport } from "./failure-analysis.js";
import type { CasambiTransportMonitorSnapshot } from "./transport-monitor.js";

function baseSnapshot(overrides: Partial<CasambiTransportMonitorSnapshot> = {}): CasambiTransportMonitorSnapshot {
  return {
    connectionType: "local",
    transport: { backend: "nats", listening: true, localAddress: "0.0.0.0", localPort: 10009, packetsSent: 0, packetsReceived: 1, lastError: null },
    adapter: { packetsReceived: 1, decoded: 1, decodeFailures: 0, lastPacketAt: new Date().toISOString(), lastDecodeError: null, recentTraces: [] },
    driver: {
      entities: 1,
      discoveryEvents: 1,
      commandsIssued: 0,
      feedbackEvents: 1,
      unmappedOpcodeEvents: 0,
      lastUnmappedOpcode: null,
      recentJourney: [],
    },
    ...overrides,
  };
}

describe("buildFailureAnalysisReport", () => {
  it("reports healthy=true and every stage passing for a fully working pipeline", () => {
    const report = buildFailureAnalysisReport(baseSnapshot());
    expect(report.healthy).toBe(true);
    expect(report.firstFailingStage).toBeNull();
    expect(report.stages.every((s) => s.status !== "fail")).toBe(true);
  });

  it("fails at Transport when the socket is bound but has received zero packets (the ORIGINAL Packets Received = 0 bug)", () => {
    const snapshot = baseSnapshot({
      transport: { backend: "nats", listening: true, localAddress: "0.0.0.0", localPort: 10009, packetsSent: 0, packetsReceived: 0, lastError: null },
      adapter: { packetsReceived: 0, decoded: 0, decodeFailures: 0, lastPacketAt: null, lastDecodeError: null, recentTraces: [] },
      driver: { entities: 0, discoveryEvents: 0, commandsIssued: 0, feedbackEvents: 0, unmappedOpcodeEvents: 0, lastUnmappedOpcode: null, recentJourney: [] },
    });
    const report = buildFailureAnalysisReport(snapshot);
    expect(report.healthy).toBe(false);
    expect(report.firstFailingStage).toBe("Transport (UDP)");
    const transportStage = report.stages.find((s) => s.stage === "Transport (UDP)")!;
    expect(transportStage.reason).toMatch(/zero packets have been received/);
    expect(transportStage.evidence).toContain("transport.packetsReceived = 0");
    expect(transportStage.suggestedFix).toMatch(/real Lithernet gateway's broadcast is not reaching supreme-lan/);
    // Downstream stages are not_applicable, not falsely "pass" — the whole point of stopping at
    // the first real failure rather than reporting misleading downstream state.
    expect(report.stages.find((s) => s.stage === "NATS")?.status).toBe("not_applicable");
    expect(report.stages.find((s) => s.stage === "Casambi Adapter")?.status).toBe("not_applicable");
    expect(report.stages.find((s) => s.stage === "Discovery / Driver")?.status).toBe("not_applicable");
  });

  it("fails at Transport with a lastError-specific reason when the socket never bound", () => {
    const snapshot = baseSnapshot({
      transport: { backend: "nats", listening: false, localAddress: null, localPort: null, packetsSent: 0, packetsReceived: 0, lastError: "EADDRINUSE" },
    });
    const report = buildFailureAnalysisReport(snapshot);
    expect(report.firstFailingStage).toBe("Transport (UDP)");
    expect(report.stages[0]?.reason).toContain("EADDRINUSE");
  });

  it("fails at Casambi Adapter when packets arrive but nothing decodes", () => {
    const snapshot = baseSnapshot({
      adapter: {
        packetsReceived: 3,
        decoded: 0,
        decodeFailures: 3,
        lastPacketAt: new Date().toISOString(),
        lastDecodeError: { raw: "garbage\r\n", message: "Malformed Casambi packet", at: new Date().toISOString() },
        recentTraces: [],
      },
      driver: { entities: 0, discoveryEvents: 0, commandsIssued: 0, feedbackEvents: 0, unmappedOpcodeEvents: 0, lastUnmappedOpcode: null, recentJourney: [] },
    });
    const report = buildFailureAnalysisReport(snapshot);
    expect(report.firstFailingStage).toBe("Casambi Adapter");
    expect(report.stages.find((s) => s.stage === "Casambi Adapter")?.reason).toMatch(/Malformed Casambi packet/);
  });

  it("fails at Discovery / Driver with the EXACT 'opcode not mapped' shape the governing brief specified", () => {
    const snapshot = baseSnapshot({
      driver: { entities: 0, discoveryEvents: 0, commandsIssued: 0, feedbackEvents: 0, unmappedOpcodeEvents: 1, lastUnmappedOpcode: 0x39, recentJourney: [] },
    });
    const report = buildFailureAnalysisReport(snapshot);
    expect(report.firstFailingStage).toBe("Discovery / Driver");
    const stage = report.stages.find((s) => s.stage === "Discovery / Driver")!;
    expect(stage.reason).toBe("Discovery ignored packet — opcode 0x39 not mapped to a driver signal.");
    expect(stage.evidence).toContain("driver.lastUnmappedOpcode = 0x39");
    expect(stage.suggestedFix).toMatch(/normalizeLocalPacket/);
  });

  it("Cloud mode: UDP-specific stages are not_applicable, never a fabricated pass/fail", () => {
    const report = buildFailureAnalysisReport(
      baseSnapshot({
        connectionType: "cloud",
        transport: null,
        adapter: null,
      }),
    );
    expect(report.stages.find((s) => s.stage === "Transport (UDP)")?.status).toBe("not_applicable");
    expect(report.stages.find((s) => s.stage === "NATS")?.status).toBe("not_applicable");
    expect(report.stages.find((s) => s.stage === "Casambi Adapter")?.status).toBe("not_applicable");
    expect(report.stages.find((s) => s.stage === "Discovery / Driver")?.status).toBe("pass");
    expect(report.healthy).toBe(true);
  });
});

describe("formatFailureAnalysisReport", () => {
  it("renders the exact ✓/✗ + Reason/Evidence/Suggested Fix shape from the certification brief", () => {
    const snapshot = baseSnapshot({
      driver: { entities: 0, discoveryEvents: 0, commandsIssued: 0, feedbackEvents: 0, unmappedOpcodeEvents: 1, lastUnmappedOpcode: 0x39, recentJourney: [] },
    });
    const text = formatFailureAnalysisReport(buildFailureAnalysisReport(snapshot));
    expect(text.startsWith(["✓ Transport (UDP)", "✓ NATS", "✓ Casambi Adapter", "✗ Discovery / Driver", "", "Reason:"].join("\n"))).toBe(true);
    expect(text).toContain("Discovery ignored packet — opcode 0x39 not mapped to a driver signal.");
    expect(text).toContain("Evidence:");
    expect(text).toContain("- driver.lastUnmappedOpcode = 0x39");
    expect(text).toContain("Suggested Fix:");
    expect(text).toContain("normalizeLocalPacket()");
  });

  it("renders a fully healthy report with no Reason section", () => {
    const text = formatFailureAnalysisReport(buildFailureAnalysisReport(baseSnapshot()));
    expect(text).not.toContain("Reason:");
    expect(text.split("\n").every((line) => line.startsWith("✓"))).toBe(true);
  });
});
