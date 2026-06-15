import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectionStorm,
  faultBackend,
  runLoad,
  seedSession,
  startHub,
  type Hub,
  type Session,
} from "./harness.js";

/**
 * A FAST CI gate version of the harness (§15): short load, a connection storm, and a
 * chaos cycle (fault → recover). Thresholds are generous so CI variance doesn't flake;
 * the real soak/load runs at scale via the CLI. Proves the gateway holds up under
 * concurrency and recovers from a backend outage without crashing.
 */
describe("load / chaos harness", () => {
  let hub: Hub;
  let session: Session;

  beforeAll(async () => {
    hub = await startHub();
    session = await seedSession(hub.baseUrl);
  });
  afterAll(async () => {
    await hub.stop();
  });

  it("sustains concurrent load with no errors", async () => {
    const r = await runLoad({ baseUrl: hub.baseUrl, session, vus: 20, durationMs: 2000 });
    expect(r.count).toBeGreaterThan(100); // it actually did work
    expect(r.errorRate).toBe(0);
    expect(r.p95).toBeLessThan(2000); // generous for CI
  });

  it("handles a WSS connection storm", async () => {
    const connected = await connectionStorm({ wsBaseUrl: hub.wsBaseUrl, session, count: 40 });
    expect(connected).toBeGreaterThanOrEqual(36); // ≥90%
  });

  it("fails cleanly during a backend outage and recovers", async () => {
    const cmd = () =>
      fetch(`${hub.baseUrl}/v1/devices/${session.deviceId}/command`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ command: { capability: "onoff", action: "toggle" } }),
      });

    // Healthy → command succeeds.
    expect((await cmd()).status).toBe(200);

    // Fault the backend → command fails cleanly (5xx), the process does NOT crash.
    const restore = await faultBackend(hub.ctx);
    expect((await cmd()).status).toBeGreaterThanOrEqual(500);

    // Recover → control resumes.
    await restore();
    expect((await cmd()).status).toBe(200);
  });
});
