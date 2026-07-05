import { describe, expect, it } from "vitest";
import { InProcessEventBus, subjectMatches, subjects } from "./event-bus.js";

describe("subjectMatches (NATS token semantics)", () => {
  it("matches literals, single-token *, and trailing >", () => {
    expect(subjectMatches("a.b.c", "a.b.c")).toBe(true);
    expect(subjectMatches("a.*.c", "a.b.c")).toBe(true);
    expect(subjectMatches("a.*.c", "a.b.d")).toBe(false);
    expect(subjectMatches("a.>", "a.b.c.d")).toBe(true);
    expect(subjectMatches("a.>", "a")).toBe(false);
    expect(subjectMatches("a.b", "a.b.c")).toBe(false);
    expect(subjectMatches("a.b.c", "a.b")).toBe(false);
  });
});

describe("InProcessEventBus", () => {
  it("delivers a published payload to a matching subscriber", async () => {
    const bus = new InProcessEventBus();
    const got: Array<{ payload: unknown; subject: string }> = [];
    await bus.subscribe("supreme.home.*.device.state", (payload, subject) =>
      got.push({ payload, subject }),
    );

    const subject = subjects.deviceState("home-1");
    await bus.publish(subject, { deviceId: "d1", value: 60 });

    expect(got).toHaveLength(1);
    expect(got[0]?.subject).toBe(subject);
    expect(got[0]?.payload).toEqual({ deviceId: "d1", value: 60 });
  });

  it("does not deliver to non-matching subjects and stops after unsubscribe", async () => {
    const bus = new InProcessEventBus();
    let count = 0;
    const sub = await bus.subscribe("supreme.home.home-1.notification", () => count++);

    await bus.publish(subjects.deviceState("home-1"), {}); // wrong subject
    expect(count).toBe(0);

    await bus.publish(subjects.notification("home-1"), { title: "hi" });
    expect(count).toBe(1);

    sub.unsubscribe();
    await bus.publish(subjects.notification("home-1"), { title: "again" });
    expect(count).toBe(1);
  });

  it("serializes payloads so subscribers can't mutate the publisher's object", async () => {
    const bus = new InProcessEventBus();
    let received: { n: number } | undefined;
    await bus.subscribe("x", (p: { n: number }) => {
      received = p;
    });
    const original = { n: 1 };
    await bus.publish("x", original);
    received!.n = 999;
    expect(original.n).toBe(1);
  });
});
