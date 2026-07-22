import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { probeYamaha } from "./yamaha-probe.js";

/** A minimal in-process YXC unit, purpose-built for the probe's own needs (reachability +
 * real zone list from /system/getFeatures) — not the full command-handling fake
 * yamaha-driver.test.ts uses, since the probe only ever binds (which triggers getFeatures),
 * never issues a command. */
function startFakeYamaha(opts: { zones?: unknown[] } = {}): Promise<{ server: Server; host: string; calls: string[] }> {
  const calls: string[] = [];
  const zones = opts.zones ?? [
    { id: "main", func_list: ["power", "volume"], input_list: ["hdmi1"], sound_program_list: [], range_step: [{ id: "volume", min: 0, max: 100, step: 1 }] },
    { id: "zone2", func_list: ["power", "volume"], input_list: ["hdmi1"], sound_program_list: [], range_step: [{ id: "volume", min: 0, max: 100, step: 1 }] },
  ];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const group = parts[2];
      const method = parts[3];
      calls.push(`${group}/${method}`);
      let body: Record<string, unknown> = { response_code: 0 };
      if (group === "system" && method === "getFeatures") {
        body = { response_code: 0, system: { func_list: [], zone_num: zones.length, input_list: [] }, zone: zones };
      } else if (method === "getStatus") {
        body = { response_code: 0, power: "on", volume: 30, mute: false, input: "hdmi1" };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, host: `127.0.0.1:${port}`, calls });
    });
  });
}

describe("probeYamaha", () => {
  it("reports reachable with the real zone list from /system/getFeatures", async () => {
    const fake = await startFakeYamaha();
    try {
      const result = await probeYamaha(fake.host);
      expect(result.reachable).toBe(true);
      expect(result.error).toBeNull();
      expect(result.zones).toEqual([
        { id: "main", label: "Zone 1", detected: true },
        { id: "zone2", label: "Zone 2", detected: true },
      ]);
      expect(fake.calls).toContain("system/getFeatures");
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  }, 10_000);

  it("reports only the zones the unit actually declares (a single-zone unit never shows Zone 2)", async () => {
    const fake = await startFakeYamaha({
      zones: [{ id: "main", func_list: ["power"], input_list: [], sound_program_list: [], range_step: [] }],
    });
    try {
      const result = await probeYamaha(fake.host);
      expect(result.reachable).toBe(true);
      expect(result.zones).toEqual([{ id: "main", label: "Zone 1", detected: true }]);
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  }, 10_000);

  it("reports unreachable with a real error when nothing is listening", async () => {
    const result = await probeYamaha("127.0.0.1:1");
    expect(result.reachable).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.zones).toEqual([]);
  }, 10_000);
});
