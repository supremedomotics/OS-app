import { newId, type DeviceId, type HomeId } from "@supreme/domain-model";
import { migrate, PgliteDb } from "@supreme/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnalyticsService } from "./index.js";

describe("AnalyticsService (PGlite)", () => {
  let db: PgliteDb;
  let analytics: AnalyticsService;
  const homeId = newId("home") as HomeId;
  const devA = newId("device") as DeviceId;
  const devB = newId("device") as DeviceId;

  beforeAll(async () => {
    db = await PgliteDb.create();
    await migrate(db);
    analytics = new AnalyticsService(db);
    // Two devices reporting energy across two hours.
    const samples: [DeviceId, number, string][] = [
      [devA, 1.0, "2026-06-04T08:10:00Z"],
      [devA, 2.0, "2026-06-04T08:40:00Z"],
      [devA, 3.0, "2026-06-04T09:10:00Z"],
      [devB, 0.5, "2026-06-04T08:20:00Z"],
    ];
    for (const [deviceId, value, ts] of samples) {
      await analytics.record({ homeId, deviceId, roomId: null, measure: "energy", value, unit: "kWh", ts });
    }
  });
  afterAll(async () => {
    await db.close();
  });

  it("summarizes totals per measure", async () => {
    const summary = await analytics.summary(homeId);
    const energy = summary.find((s) => s.measure === "energy")!;
    expect(energy.total).toBeCloseTo(6.5);
    expect(energy.count).toBe(4);
    expect(energy.unit).toBe("kWh");
  });

  it("ranks top consumers", async () => {
    const top = await analytics.topConsumers(homeId, "energy");
    expect(top[0]!.deviceId).toBe(devA);
    expect(top[0]!.total).toBeCloseTo(6.0);
    expect(top[1]!.deviceId).toBe(devB);
  });

  it("buckets a device series by hour", async () => {
    const series = await analytics.hourlySeries(devA, "energy");
    expect(series).toHaveLength(2);
    expect(series[0]!.hour).toBe("2026-06-04T08");
    expect(series[0]!.total).toBeCloseTo(3.0);
    expect(series[1]!.total).toBeCloseTo(3.0);
  });

  it("ingests sensor + climate state, ignores others", async () => {
    const h2 = newId("home") as HomeId;
    const d = newId("device") as DeviceId;
    await analytics.ingestState({ homeId: h2, deviceId: d, roomId: null }, { kind: "sensor", value: 42, unit: "W", measure: "power" });
    await analytics.ingestState({ homeId: h2, deviceId: d, roomId: null }, { kind: "temperature", ambientC: 21.5, targetC: 22, mode: "auto" });
    await analytics.ingestState({ homeId: h2, deviceId: d, roomId: null }, { kind: "onoff", on: true });
    const summary = await analytics.summary(h2);
    expect(summary.map((s) => s.measure).sort()).toEqual(["power", "temperature"]);
  });
});
