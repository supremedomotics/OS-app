import { describe, expect, it } from "vitest";
import { casambiPipelineStages } from "../casambi/pipeline-status.js";
import { knxDiscoveryStages } from "../knx/knx-discovery-pipeline.js";
import { firstNonPassingStage, formatPipelineStages } from "./pipeline-stages.js";
import type { CasambiTransportMonitorSnapshot } from "../casambi/transport-monitor.js";
import type { KnxDiscoveryDiagnostics } from "../knx-discovery.js";

function casambiSnapshot(over: Partial<CasambiTransportMonitorSnapshot> = {}): CasambiTransportMonitorSnapshot {
  return {
    connectionType: "local",
    transport: { backend: "nats", listening: true, localAddress: "0.0.0.0", localPort: 10009, packetsSent: 6, packetsReceived: 0, lastError: null },
    adapter: { packetsReceived: 0, decoded: 0, decodeFailures: 0, lastPacketAt: null, lastDecodeError: null, recentTraces: [] },
    driver: { entities: 0, discoveryEvents: 0, commandsIssued: 0, feedbackEvents: 0, unmappedOpcodeEvents: 0, lastUnmappedOpcode: null, recentJourney: [] },
    ...over,
  };
}

describe("casambiPipelineStages — the reported real-world state (Sent=6, Received=0)", () => {
  it("passes Socket/Listening but reports Receiving as WAITING with the bridge-networking cause", () => {
    const stages = casambiPipelineStages(casambiSnapshot());
    const byName = Object.fromEntries(stages.map((s) => [s.name, s]));
    expect(byName["Socket"]!.status).toBe("pass");
    expect(byName["Listening"]!.status).toBe("pass");
    // The crux: a bound, error-free socket that has received nothing is WAITING, never PASS.
    expect(byName["Receiving"]!.status).toBe("waiting");
    expect(byName["Receiving"]!.detail).toMatch(/does not deliver LAN broadcast\/multicast into containers/);
    expect(firstNonPassingStage(stages)!.name).toBe("Receiving");
  });

  it("passes the whole pipeline once real traffic has flowed end to end", () => {
    const stages = casambiPipelineStages(
      casambiSnapshot({
        transport: { backend: "nats", listening: true, localAddress: "0.0.0.0", localPort: 10009, packetsSent: 6, packetsReceived: 4, lastError: null },
        adapter: { packetsReceived: 4, decoded: 4, decodeFailures: 0, lastPacketAt: new Date().toISOString(), lastDecodeError: null, recentTraces: [] },
        driver: { entities: 2, discoveryEvents: 2, commandsIssued: 1, feedbackEvents: 3, unmappedOpcodeEvents: 0, lastUnmappedOpcode: null, recentJourney: [] },
      }),
    );
    expect(stages.every((s) => s.status === "pass")).toBe(true);
    expect(firstNonPassingStage(stages)).toBeNull();
  });

  it("names a decode mismatch rather than blaming reception when packets DID arrive", () => {
    const stages = casambiPipelineStages(
      casambiSnapshot({
        transport: { backend: "nats", listening: true, localAddress: "0.0.0.0", localPort: 10009, packetsSent: 6, packetsReceived: 3, lastError: null },
        adapter: {
          packetsReceived: 3,
          decoded: 0,
          decodeFailures: 3,
          lastPacketAt: new Date().toISOString(),
          lastDecodeError: { raw: "junk", message: "Malformed Casambi packet", at: new Date().toISOString() },
          recentTraces: [],
        },
      }),
    );
    const decoding = stages.find((s) => s.name === "Decoding")!;
    expect(decoding.status).toBe("waiting");
    expect(decoding.detail).toMatch(/Net ID or Data Format mismatch/);
  });

  it("reports Cloud mode as not-applicable instead of seven misleading UDP rows", () => {
    const stages = casambiPipelineStages(casambiSnapshot({ connectionType: "cloud", transport: null, adapter: null }));
    expect(stages).toHaveLength(1);
    expect(stages[0]!.detail).toMatch(/Not applicable/);
  });
});

describe("knxDiscoveryStages — the Docker-bridge multicast false-PASS", () => {
  const joinedButDeaf: KnxDiscoveryDiagnostics = {
    socketBound: true,
    joinedMulticast: true,
    joinError: null,
    datagramsReceived: 0,
    searchResponsesParsed: 0,
    gatewaysFound: 0,
  };

  it("passes 'Joined Multicast' yet stops at 'Received Search Response' — the exact silent failure", () => {
    const stages = knxDiscoveryStages(joinedButDeaf);
    const byName = Object.fromEntries(stages.map((s) => [s.name, s]));
    expect(byName["Socket"]!.status).toBe("pass");
    // The join genuinely succeeded — reporting it as a failure would be wrong too.
    expect(byName["Joined Multicast"]!.status).toBe("pass");
    expect(byName["Joined Multicast"]!.detail).toMatch(/acceptance does not guarantee delivery/);
    // ...but reception is its own stage, and THAT is where the pipeline actually stops.
    expect(byName["Received Search Response"]!.status).toBe("waiting");
    expect(byName["Received Search Response"]!.detail).toMatch(/accepts the multicast join but never delivers multicast in from the physical LAN/);
    expect(firstNonPassingStage(stages)!.name).toBe("Received Search Response");
  });

  it("distinguishes a genuinely failed join from a successful-but-deaf one", () => {
    const stages = knxDiscoveryStages({ ...joinedButDeaf, joinedMulticast: false, joinError: "ENODEV" });
    const join = stages.find((s) => s.name === "Joined Multicast")!;
    expect(join.status).toBe("fail");
    expect(join.detail).toBe("ENODEV");
  });

  it("blames parsing, not reception, when datagrams arrived but none were SEARCH_RESPONSEs", () => {
    const stages = knxDiscoveryStages({ ...joinedButDeaf, datagramsReceived: 2 });
    expect(stages.find((s) => s.name === "Received Search Response")!.status).toBe("pass");
    const parsed = stages.find((s) => s.name === "Gateway Parsed")!;
    expect(parsed.status).toBe("waiting");
    expect(parsed.detail).toMatch(/none parsed as a KNXnet\/IP SEARCH_RESPONSE/);
  });

  it("passes every stage on a real successful discovery", () => {
    const stages = knxDiscoveryStages({ socketBound: true, joinedMulticast: true, joinError: null, datagramsReceived: 3, searchResponsesParsed: 2, gatewaysFound: 2 });
    expect(stages.every((s) => s.status === "pass")).toBe(true);
  });
});

describe("formatPipelineStages", () => {
  it("renders ✓ / ✗ / … per stage with the reason attached", () => {
    const text = formatPipelineStages(knxDiscoveryStages({ socketBound: true, joinedMulticast: false, joinError: "ENODEV", datagramsReceived: 0, searchResponsesParsed: 0, gatewaysFound: 0 }));
    expect(text).toMatch(/^✓ Socket/m);
    expect(text).toMatch(/^✗ Joined Multicast — ENODEV$/m);
    expect(text).toMatch(/^… Received Search Response/m);
  });
});
