import { describe, expect, it, vi } from "vitest";
import {
  NotificationService,
  type IPushProvider,
  type IPushTokenSource,
  type PushPayload,
  type PushTarget,
} from "./index.js";

function tokens(targets: PushTarget[]): IPushTokenSource {
  return { targetsFor: () => targets };
}
function provider(platform: PushTarget["platform"], deliver = vi.fn(async () => {})): IPushProvider & { deliver: typeof deliver } {
  return { platform, deliver };
}
const payload = (over: Partial<PushPayload> = {}): PushPayload => ({
  title: "Doorbell",
  body: "Someone is at the front door",
  category: "doorbell",
  priority: "high",
  ...over,
});

describe("NotificationService — fan-out", () => {
  it("delivers to every registered device across platforms", async () => {
    const apns = provider("apns");
    const fcm = provider("fcm");
    const svc = new NotificationService({
      providers: [apns, fcm],
      tokens: tokens([
        { deviceId: "iphone", platform: "apns", token: "t1" },
        { deviceId: "pixel", platform: "fcm", token: "t2" },
      ]),
    });
    const res = await svc.notify({ accountId: "a1", payload: payload() });
    expect(res.status).toBe("delivered");
    expect(res.receipts.every((r) => r.status === "delivered")).toBe(true);
    expect(apns.deliver).toHaveBeenCalledWith("t1", expect.objectContaining({ category: "doorbell" }));
    expect(fcm.deliver).toHaveBeenCalledWith("t2", expect.anything());
  });

  it("reports a per-device failure without blocking the others", async () => {
    const apns = provider("apns", vi.fn(async () => { throw new Error("APNs 410 gone"); }));
    const fcm = provider("fcm");
    const svc = new NotificationService({
      providers: [apns, fcm],
      tokens: tokens([
        { deviceId: "iphone", platform: "apns", token: "t1" },
        { deviceId: "pixel", platform: "fcm", token: "t2" },
      ]),
    });
    const res = await svc.notify({ accountId: "a1", payload: payload() });
    expect(res.receipts.find((r) => r.deviceId === "iphone")?.status).toBe("failed");
    expect(res.receipts.find((r) => r.deviceId === "pixel")?.status).toBe("delivered");
  });

  it("returns no_targets when the account has no devices", async () => {
    const svc = new NotificationService({ providers: [provider("apns")], tokens: tokens([]) });
    expect((await svc.notify({ accountId: "a1", payload: payload() })).status).toBe("no_targets");
  });
});

describe("NotificationService — dedup", () => {
  it("suppresses a duplicate within the window and allows it after", async () => {
    let t = 0;
    const apns = provider("apns");
    const svc = new NotificationService({
      providers: [apns],
      tokens: tokens([{ deviceId: "iphone", platform: "apns", token: "t1" }]),
      dedupeWindowMs: 1000,
      now: () => t,
    });
    expect((await svc.notify({ accountId: "a1", payload: payload(), dedupeKey: "motion-cam1" })).status).toBe("delivered");
    t = 500;
    expect((await svc.notify({ accountId: "a1", payload: payload(), dedupeKey: "motion-cam1" })).status).toBe("suppressed_duplicate");
    t = 1500;
    expect((await svc.notify({ accountId: "a1", payload: payload(), dedupeKey: "motion-cam1" })).status).toBe("delivered");
    expect(apns.deliver).toHaveBeenCalledTimes(2);
  });
});

describe("NotificationService — quiet hours", () => {
  const svc = (priority: PushPayload["priority"]) =>
    new NotificationService({
      providers: [provider("apns")],
      tokens: tokens([{ deviceId: "iphone", platform: "apns", token: "t1" }]),
      quietHoursFor: () => ({ startMinute: 22 * 60, endMinute: 7 * 60 }), // 22:00–07:00, wraps midnight
    }).notify({ accountId: "a1", payload: payload({ priority }), localMinute: 1 * 60 }); // 01:00

  it("holds a non-critical notification during quiet hours", async () => {
    expect((await svc("high")).status).toBe("suppressed_quiet_hours");
  });
  it("lets a critical alert through quiet hours", async () => {
    expect((await svc("critical")).status).toBe("delivered");
  });
});
