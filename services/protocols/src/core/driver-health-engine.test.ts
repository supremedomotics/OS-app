import { describe, expect, it } from "vitest";
import { computeDriverHealth, type DriverHealthInputs } from "./driver-health-engine.js";

const notImplemented: DriverHealthInputs = {
  connectionState: "not_implemented",
  transportState: "not_implemented",
  discoveryState: "not_implemented",
  feedbackState: "not_implemented",
  synchronizationState: "not_implemented",
  latencyMs: null,
  reconnectCount: 0,
  lastPacketAt: null,
  packetsReceived: 0,
  packetsLost: 0,
  averageResponseTimeMs: null,
  entityCount: 0,
  errors: [],
  warnings: [],
  diagnosticMessages: [],
};

const healthy: DriverHealthInputs = {
  ...notImplemented,
  connectionState: "connected",
  transportState: "connected",
  discoveryState: "connected",
  feedbackState: "connected",
  synchronizationState: "connected",
  latencyMs: 20,
  packetsReceived: 100,
};

describe("computeDriverHealth", () => {
  it("all states not_implemented yields verdict not_implemented and score 0", () => {
    const snapshot = computeDriverHealth(notImplemented);
    expect(snapshot.verdict).toBe("not_implemented");
    expect(snapshot.healthScore).toBe(0);
  });

  it("all states connected with no errors yields a healthy verdict and a near-100 score", () => {
    const snapshot = computeDriverHealth(healthy);
    expect(snapshot.verdict).toBe("healthy");
    expect(snapshot.healthScore).toBeGreaterThanOrEqual(90);
  });

  it("any error present forces verdict error even with otherwise-connected states", () => {
    const snapshot = computeDriverHealth({ ...healthy, errors: ["socket reset"] });
    expect(snapshot.verdict).toBe("error");
  });

  it("an error-lifecycle state forces verdict error", () => {
    const snapshot = computeDriverHealth({ ...healthy, connectionState: "error" });
    expect(snapshot.verdict).toBe("error");
  });

  it("a disconnected state with no errors degrades the score without being an error verdict", () => {
    const snapshot = computeDriverHealth({ ...healthy, connectionState: "disconnected", transportState: "disconnected" });
    expect(snapshot.verdict).toBe("degraded");
    expect(snapshot.healthScore).toBeLessThan(90);
  });

  it("reconnect count reduces the score proportionally, capped at 15 points", () => {
    const some = computeDriverHealth({ ...healthy, reconnectCount: 2 }); // 2*3 = 6 point penalty
    const many = computeDriverHealth({ ...healthy, reconnectCount: 20 }); // capped at 15, not 60
    expect(some.healthScore).toBe(94);
    expect(many.healthScore).toBe(85);
  });

  it("packetLossRatio is null when no packets have been seen at all", () => {
    expect(computeDriverHealth(notImplemented).packetLossRatio).toBeNull();
  });

  it("packetLossRatio is computed and degrades the score when packets are lost", () => {
    const withLoss = computeDriverHealth({ ...healthy, packetsReceived: 90, packetsLost: 10 });
    expect(withLoss.packetLossRatio).toBeCloseTo(0.1);
    expect(withLoss.healthScore).toBeLessThan(computeDriverHealth(healthy).healthScore);
  });

  it("score is clamped to [0, 100]", () => {
    const worst = computeDriverHealth({
      ...notImplemented,
      connectionState: "error",
      transportState: "error",
      discoveryState: "error",
      feedbackState: "error",
      synchronizationState: "error",
      errors: ["a", "b", "c", "d", "e", "f"],
      warnings: ["a", "b", "c", "d", "e", "f"],
      reconnectCount: 50,
      packetsReceived: 0,
      packetsLost: 100,
    });
    expect(worst.healthScore).toBeGreaterThanOrEqual(0);
    expect(worst.healthScore).toBeLessThanOrEqual(100);
  });
});
