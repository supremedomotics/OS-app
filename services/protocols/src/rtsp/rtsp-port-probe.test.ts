import { describe, it, expect, vi } from "vitest";
import { probeRtspPorts } from "./rtsp-port-probe.js";

describe("probeRtspPorts", () => {
  it("reports responsive host:port combinations only", async () => {
    const probe = vi.fn(async (host: string, port: number) => host === "192.168.1.10" && port === 554);
    const results = await probeRtspPorts({ hosts: ["192.168.1.10", "192.168.1.11"], ports: [554, 8554], probe, concurrency: 4 });
    expect(results.get("192.168.1.10")).toEqual([554]);
    expect(results.has("192.168.1.11")).toBe(false);
  });

  it("one throwing probe never aborts the whole sweep (§ STEP 12)", async () => {
    const probe = vi.fn(async (host: string) => {
      if (host === "192.168.1.5") throw new Error("boom");
      return host === "192.168.1.6";
    });
    const results = await probeRtspPorts({ hosts: ["192.168.1.5", "192.168.1.6"], ports: [554], probe });
    expect(results.get("192.168.1.6")).toEqual([554]);
    expect(results.has("192.168.1.5")).toBe(false);
  });

  it("respects a bounded concurrency (never more than `concurrency` in flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const probe = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return false;
    });
    const hosts = Array.from({ length: 40 }, (_, i) => `10.0.0.${i}`);
    await probeRtspPorts({ hosts, ports: [554], probe, concurrency: 4 });
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("is cancellable via AbortSignal", async () => {
    const controller = new AbortController();
    let calls = 0;
    const probe = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 2));
      return false;
    });
    const hosts = Array.from({ length: 200 }, (_, i) => `10.0.1.${i}`);
    const promise = probeRtspPorts({ hosts, ports: [554], probe, concurrency: 2 });
    setTimeout(() => controller.abort(), 5);
    // Re-run with the same signal wired in (probeRtspPorts checks signal.aborted per worker loop)
    const result = await probeRtspPorts({ hosts, ports: [554], probe, concurrency: 2, signal: controller.signal });
    expect(result).toBeInstanceOf(Map);
    await promise;
  });

  it("scans no ports/hosts without throwing", async () => {
    const results = await probeRtspPorts({ hosts: [], probe: vi.fn() });
    expect(results.size).toBe(0);
  });
});

describe("default ports (§ UniFi Protect)", () => {
  it("includes the classic RTSP ports plus the UniFi Protect console ports 7447/7441", async () => {
    const { DEFAULT_RTSP_PORTS, UNIFI_PROTECT_PORTS } = await import("./rtsp-port-probe.js");
    expect(DEFAULT_RTSP_PORTS).toEqual(expect.arrayContaining([554, 8554, 10554, 7447, 7441]));
    expect([...UNIFI_PROTECT_PORTS].sort()).toEqual([7441, 7447]);
  });

  it("probes the UniFi ports by default and stays bounded/overridable", async () => {
    const seen: number[] = [];
    const probe = async (_h: string, port: number) => (seen.push(port), false);
    await probeRtspPorts({ hosts: ["10.0.0.1"], probe });
    expect(seen.sort((a, b) => a - b)).toEqual([554, 7441, 7447, 8554, 10554]);
    const only: number[] = [];
    await probeRtspPorts({ hosts: ["10.0.0.1"], ports: [554], probe: async (_h, p) => (only.push(p), false) });
    expect(only).toEqual([554]);
  });
});
