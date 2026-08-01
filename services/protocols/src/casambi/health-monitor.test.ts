import { describe, expect, it } from "vitest";
import { udpStage } from "./health-monitor.js";

/**
 * § UDP Diagnostics audit — `udpStage` is the one place that decides whether a lack of UDP
 * traffic is a failure or just "hasn't happened yet." These tests pin the honesty rule down:
 * only a real socket error is a failure; "bound but nothing received yet" is a normal, healthy
 * waiting state for a connectionless, push-based protocol.
 */
describe("udpStage", () => {
  it("is 'not_configured' for Cloud mode regardless of socket state", () => {
    expect(udpStage("cloud", "bound", 5)).toBe("not_configured");
    expect(udpStage("cloud", "error", 0)).toBe("not_configured");
  });

  it("is 'not_configured' for Local mode before the socket has ever bound", () => {
    expect(udpStage("local", "closed", 0)).toBe("not_configured");
  });

  it("is 'socket_error' only on a real socket error, never merely because nothing arrived", () => {
    expect(udpStage("local", "error", 0)).toBe("socket_error");
  });

  it("is 'bound_waiting' once bound with zero packets received — a healthy, normal state", () => {
    expect(udpStage("local", "bound", 0)).toBe("bound_waiting");
  });

  it("is 'active' once at least one packet has been received", () => {
    expect(udpStage("local", "bound", 1)).toBe("active");
    expect(udpStage("local", "bound", 14)).toBe("active");
  });
});
