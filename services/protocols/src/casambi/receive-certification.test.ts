import { describe, expect, it } from "vitest";
import { casambiReceivePipeline, type LanForensicsInput, type ReceivePipelineInputs } from "./receive-pipeline.js";
import { buildReceiveCertificationReport, classifyReceiveRootCause, compareWithWireshark, formatReceiveCertificationReport } from "./receive-certification.js";
import type { CasambiTransportMonitorSnapshot } from "./transport-monitor.js";

/**
 * § Runtime Data Path Verification. These tests exist because the classifier's output is a
 * DIAGNOSIS — a wrong one sends someone to rewrite a codec that was never reached, or to blame a
 * gateway that is transmitting perfectly. Each test pins one real evidence combination to the one
 * conclusion it actually supports, including the combinations whose honest answer is "unknown".
 */
function snapshot(overrides: {
  connectionType?: "local" | "cloud";
  transportReceived?: number | null;
  listening?: boolean;
  backend?: "nats" | "local-direct";
  adapterReceived?: number;
  decoded?: number;
  decodeFailures?: number;
  discoveryEvents?: number;
  entities?: number;
  unmappedOpcodeEvents?: number;
  lastUnmappedOpcode?: number | null;
}): CasambiTransportMonitorSnapshot {
  const o = { connectionType: "local" as const, backend: "nats" as const, listening: true, transportReceived: 0, adapterReceived: 0, decoded: 0, decodeFailures: 0, discoveryEvents: 0, entities: 0, unmappedOpcodeEvents: 0, lastUnmappedOpcode: null, ...overrides };
  return {
    connectionType: o.connectionType,
    transport:
      o.connectionType === "local"
        ? { backend: o.backend, listening: o.listening, localAddress: "0.0.0.0", localPort: 10009, packetsSent: 6, packetsReceived: o.transportReceived, lastError: null }
        : null,
    adapter:
      o.connectionType === "local"
        ? { packetsReceived: o.adapterReceived, decoded: o.decoded, decodeFailures: o.decodeFailures, lastPacketAt: null, lastDecodeError: o.decodeFailures > 0 ? { raw: "junk", message: "bad frame", at: "2026-08-02T00:00:00.000Z" } : null, recentTraces: [] }
        : null,
    driver: { entities: o.entities, discoveryEvents: o.discoveryEvents, commandsIssued: 0, feedbackEvents: 0, unmappedOpcodeEvents: o.unmappedOpcodeEvents, lastUnmappedOpcode: o.lastUnmappedOpcode, recentJourney: [] },
  };
}

const lanWithProbe = (datagramsReceived: number, listening = true): LanForensicsInput => ({
  network: { procAvailable: true, networkNamespace: "net:[4026531833]", defaultGateway: "192.168.0.1", routes: [], interfaces: [{ name: "eth0", address: "192.168.0.10", internal: false, cidr: "192.168.0.10/24" }], udpSockets: [] },
  sockets: [{ sessionId: "s1", forensics: { boundAddress: "0.0.0.0", boundPort: 10009, recvBufferSize: 212992, kernelSocket: { rxQueue: 0, drops: 0 } } }],
  probe: { listening, boundPort: 10009, datagramsReceived, firstDatagramAt: datagramsReceived > 0 ? "2026-08-02T00:00:00.000Z" : null, lastDatagramAt: null, lastError: null },
  probeDisabledReason: null,
});

function classify(inputs: ReceivePipelineInputs) {
  return classifyReceiveRootCause(inputs, casambiReceivePipeline(inputs));
}

describe("classifyReceiveRootCause — the honest-unknown cases", () => {
  it("reports UNKNOWN, not a guess, when both listeners are deaf and no host capture was supplied", () => {
    // This is the user's exact reported state. Two mutually exclusive causes produce identical
    // counters, and nothing inside the process can separate them.
    const v = classify({ snapshot: snapshot({ transportReceived: 0 }), lan: lanWithProbe(0) });
    expect(v.cause).toBe("unknown");
    expect(v.needed).toMatch(/host-side packet capture/);
    // It must name BOTH candidate causes rather than leaning toward one.
    expect(v.summary).toMatch(/not transmitting/);
    expect(v.summary).toMatch(/blocked before this network namespace/);
  });

  it("reports UNKNOWN when no probe was running — a zero with nothing to compare it against", () => {
    const v = classify({ snapshot: snapshot({ transportReceived: 0 }), lan: { network: null, sockets: [], probe: null, probeDisabledReason: "SUPREME_LAN_PROBE_PORT is not set" } });
    expect(v.cause).toBe("unknown");
    expect(v.needed).toMatch(/SUPREME_LAN_PROBE_PORT/);
  });
});

describe("classifyReceiveRootCause — resolving the unknown with a host capture", () => {
  it("BLOCKED BEFORE SOCKET when the capture saw packets but neither listener did", () => {
    const v = classify({ snapshot: snapshot({ transportReceived: 0 }), lan: lanWithProbe(0), wireshark: { packets: 145 } });
    expect(v.cause).toBe("packets_blocked_before_socket");
    expect(v.evidence).toContain("wireshark.packets = 145");
    expect(v.needed).toBeNull();
  });

  it("GATEWAY NOT TRANSMITTING when the capture also saw nothing", () => {
    const v = classify({ snapshot: snapshot({ transportReceived: 0 }), lan: lanWithProbe(0), wireshark: { packets: 0 } });
    expect(v.cause).toBe("gateway_not_transmitting");
    expect(v.summary).toMatch(/not in SupremeOS/);
  });
});

describe("classifyReceiveRootCause — localizing a loss inside SupremeOS", () => {
  it("LOST BEFORE NATS when the independent probe receives but the driver's socket does not", () => {
    const v = classify({ snapshot: snapshot({ transportReceived: 0 }), lan: lanWithProbe(145) });
    expect(v.cause).toBe("packets_lost_before_nats");
    expect(v.summary).toMatch(/INSIDE SupremeOS/);
  });

  it("BLOCKED BEFORE SOCKET when the kernel itself reports drops — checked before any app counter", () => {
    const lan = lanWithProbe(0);
    lan.sockets![0]!.forensics!.kernelSocket = { rxQueue: 4096, drops: 12 };
    const v = classify({ snapshot: snapshot({ transportReceived: 3 }), lan });
    expect(v.cause).toBe("packets_blocked_before_socket");
    expect(v.evidence).toContain("/proc/net/udp drops = 12");
  });

  it("LOST BEFORE DECODER when the socket received but the engine did not", () => {
    const v = classify({ snapshot: snapshot({ transportReceived: 10, adapterReceived: 0 }), lan: lanWithProbe(10) });
    expect(v.cause).toBe("packets_lost_before_decoder");
  });

  it("REJECTED BY DECODER when everything arrived and nothing parsed", () => {
    const v = classify({ snapshot: snapshot({ transportReceived: 4, adapterReceived: 4, decoded: 0, decodeFailures: 4 }), lan: lanWithProbe(4) });
    expect(v.cause).toBe("packets_rejected_by_decoder");
    expect(v.summary).toMatch(/wire-format mismatch, not a reception problem/);
  });

  it("IGNORED BY DISCOVERY when packets decoded but carried unmapped opcodes", () => {
    const v = classify({ snapshot: snapshot({ transportReceived: 4, adapterReceived: 4, decoded: 4, unmappedOpcodeEvents: 4, lastUnmappedOpcode: 0x1e }), lan: lanWithProbe(4) });
    expect(v.cause).toBe("packets_ignored_by_discovery");
    expect(v.summary).toMatch(/0x1e/);
  });

  it("ENTITIES NOT CREATED when discovery worked but mapping produced nothing", () => {
    const v = classify({ snapshot: snapshot({ transportReceived: 4, adapterReceived: 4, decoded: 4, discoveryEvents: 2, entities: 0 }), lan: lanWithProbe(4) });
    expect(v.cause).toBe("entities_not_created");
  });

  it("RECEIVED BY SOCKET — the healthy end-to-end path", () => {
    const v = classify({ snapshot: snapshot({ transportReceived: 9, adapterReceived: 9, decoded: 9, discoveryEvents: 3, entities: 3 }), lan: lanWithProbe(9) });
    expect(v.cause).toBe("packets_received_by_socket");
    expect(v.needed).toBeNull();
  });
});

describe("compareWithWireshark", () => {
  it("computes the real difference and names the stage where packets disappear", () => {
    const inputs: ReceivePipelineInputs = { snapshot: snapshot({ transportReceived: 0 }), lan: lanWithProbe(0), wireshark: { packets: 145, captureFilter: "udp port 10009" } };
    const c = compareWithWireshark(inputs, classify(inputs).cause);
    expect(c).toMatchObject({ wiresharkPackets: 145, socketPackets: 0, difference: 145, stageWherePacketsDisappear: "Before socket receive", captureFilter: "udp port 10009" });
  });

  it("refuses to compute a difference when no capture count was supplied — never assumes zero", () => {
    const inputs: ReceivePipelineInputs = { snapshot: snapshot({ transportReceived: 5 }), lan: lanWithProbe(5) };
    const c = compareWithWireshark(inputs, classify(inputs).cause);
    expect(c.wiresharkPackets).toBeNull();
    expect(c.difference).toBeNull();
    expect(c.stageWherePacketsDisappear).toMatch(/no host capture count was supplied/);
  });
});

describe("buildReceiveCertificationReport", () => {
  it("never certifies a report containing an un-run check", () => {
    // Nothing arrived, so Decoder/Discovery/Entity Creation were never exercised.
    const r = buildReceiveCertificationReport({ snapshot: snapshot({ transportReceived: 0 }), lan: lanWithProbe(0) });
    expect(r.certified).toBe(false);
    expect(r.sections.filter((s) => s.status === "not_evaluated").map((s) => s.name)).toEqual(["Decoder", "Discovery", "Entity Creation"]);
    // Crucially, an un-run check is NOT reported as a pass.
    expect(r.sections.some((s) => s.status === "pass" && s.name === "Decoder")).toBe(false);
  });

  it("certifies only when every one of the seven sections was evaluated AND passed", () => {
    const r = buildReceiveCertificationReport({
      snapshot: snapshot({ transportReceived: 9, adapterReceived: 9, decoded: 9, discoveryEvents: 3, entities: 3 }),
      lan: lanWithProbe(9),
    });
    expect(r.sections.map((s) => s.name)).toEqual(["Socket", "Network", "Packet Reception", "NATS", "Decoder", "Discovery", "Entity Creation"]);
    expect(r.sections.every((s) => s.status === "pass")).toBe(true);
    expect(r.certified).toBe(true);
    expect(r.rootCause.cause).toBe("packets_received_by_socket");
  });

  it("marks Network as not_evaluated rather than passing it when forensics were never collected", () => {
    const r = buildReceiveCertificationReport({ snapshot: snapshot({ transportReceived: 9, adapterReceived: 9, decoded: 9, discoveryEvents: 3, entities: 3 }), lan: null });
    expect(r.sections.find((s) => s.name === "Network")?.status).toBe("not_evaluated");
    expect(r.certified).toBe(false);
  });

  it("renders the brief's literal report shape", () => {
    const text = formatReceiveCertificationReport(buildReceiveCertificationReport({ snapshot: snapshot({ transportReceived: 0 }), lan: lanWithProbe(0), wireshark: { packets: 145 } }));
    expect(text).toContain("Receive Pipeline Report");
    expect(text).toContain("Overall Root Cause");
    expect(text).toContain("PACKETS BLOCKED BEFORE SOCKET");
    expect(text).toContain("Stage where packets disappear: Before socket receive");
  });
});

describe("casambiReceivePipeline — per-stage instrumentation", () => {
  const stages = casambiReceivePipeline({ snapshot: snapshot({ transportReceived: 10, adapterReceived: 10, decoded: 8, decodeFailures: 2, discoveryEvents: 3, entities: 3 }), lan: lanWithProbe(10) });

  it("exposes all eleven stages independently, in pipeline order — nothing aggregated", () => {
    expect(stages.map((s) => s.name)).toEqual([
      "OS Network Stack",
      "supreme-lan UDP Socket",
      "Datagram Received",
      "Raw Packet Recorder",
      "NATS Publish",
      "Gateway Subscriber",
      "Casambi UDP Engine",
      "Protocol Decoder",
      "Discovery Engine",
      "Entity Mapper",
      "Room Assignment",
    ]);
  });

  it("reports real entered/exited/failures where they are measured", () => {
    const decoder = stages.find((s) => s.name === "Protocol Decoder")!;
    expect(decoder.metrics).toMatchObject({ entered: 10, exited: 8, failures: 2 });
  });

  it("explains every null instead of reporting a misleading zero", () => {
    for (const stage of stages) {
      const m = stage.metrics!;
      const hasNull = [m.entered, m.exited, m.failures, m.latencyMs].some((v) => v === null);
      if (hasNull) expect(m.unmeasured, `${stage.name} has a null metric but no explanation`).not.toBeNull();
    }
  });

  it("never invents a Room Assignment counter — it is not a driver-side step", () => {
    const room = stages.find((s) => s.name === "Room Assignment")!;
    expect(room.metrics!.exited).toBeNull();
    expect(room.metrics!.unmeasured).toMatch(/not performed by the Casambi driver/);
  });

  it("reports the OS Network Stack's `entered` as unknowable rather than zero", () => {
    const os = stages.find((s) => s.name === "OS Network Stack")!;
    expect(os.metrics!.entered).toBeNull();
    expect(os.metrics!.unmeasured).toMatch(/cannot report datagrams that never reached it/);
  });

  it("collapses to a single honest row in Cloud mode instead of eleven inapplicable ones", () => {
    const cloud = casambiReceivePipeline({ snapshot: snapshot({ connectionType: "cloud" }) });
    expect(cloud).toHaveLength(1);
    expect(cloud[0]!.detail).toMatch(/REST\/WebSocket/);
  });
});
