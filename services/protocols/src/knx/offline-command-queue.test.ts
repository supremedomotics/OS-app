import { describe, expect, it, vi } from "vitest";
import { OfflineCommandQueue } from "./offline-command-queue.js";

interface Cmd { capability: string; value: unknown }

function makeQueue(ttlMs = 1000, now = () => 0) {
  return new OfflineCommandQueue<string, Cmd>({ ttlMs, now, keyOf: (subject, cmd) => `${subject}:${cmd.capability}` });
}

describe("OfflineCommandQueue", () => {
  it("MERGE: a second command for the same subject+kind supersedes the first, never both run", async () => {
    const q = makeQueue();
    q.enqueue("device-1", { capability: "onoff", value: "on" });
    q.enqueue("device-1", { capability: "onoff", value: "off" });
    expect(q.size()).toBe(1);

    const executed: Cmd[] = [];
    const result = await q.drain(async (_s, c) => { executed.push(c); });
    expect(executed).toEqual([{ capability: "onoff", value: "off" }]);
    expect(result).toEqual({ executed: 1, expired: 0 });
  });

  it("different capabilities on the same device queue independently", async () => {
    const q = makeQueue();
    q.enqueue("device-1", { capability: "onoff", value: "on" });
    q.enqueue("device-1", { capability: "brightness", value: 80 });
    expect(q.size()).toBe(2);
    const executed: Cmd[] = [];
    await q.drain(async (_s, c) => { executed.push(c); });
    expect(executed).toHaveLength(2);
  });

  it("EXPIRE: a command older than ttlMs is dropped, never executed late", async () => {
    let clock = 0;
    const q = makeQueue(1000, () => clock);
    q.enqueue("device-1", { capability: "onoff", value: "on" });
    clock = 5000; // well past the 1000ms TTL
    const executed: Cmd[] = [];
    const result = await q.drain(async (_s, c) => { executed.push(c); });
    expect(executed).toEqual([]);
    expect(result).toEqual({ executed: 0, expired: 1 });
  });

  it("CANCEL: clear() empties the queue explicitly, never implicitly on drain failure", async () => {
    const q = makeQueue();
    q.enqueue("device-1", { capability: "onoff", value: "on" });
    q.clear();
    expect(q.size()).toBe(0);
  });

  it("drain() always empties the queue, even when an execution throws — no silent retry loop", async () => {
    const q = makeQueue();
    q.enqueue("device-1", { capability: "onoff", value: "on" });
    const failing = vi.fn().mockRejectedValue(new Error("write failed"));
    await expect(q.drain(failing)).rejects.toThrow("write failed");
    expect(q.size()).toBe(0); // already cleared before execution — a failure doesn't resurrect it
  });

  it("evict() removes only queued commands matching the predicate, leaving others intact (§ Driver Lifecycle Completion)", async () => {
    const q = makeQueue();
    q.enqueue("device-1", { capability: "onoff", value: "on" });
    q.enqueue("device-1", { capability: "brightness", value: 80 });
    q.enqueue("device-2", { capability: "onoff", value: "off" });
    const removed = q.evict((subject) => subject === "device-1");
    expect(removed).toBe(2);
    expect(q.size()).toBe(1);
    const executed: Cmd[] = [];
    await q.drain(async (_s, c) => { executed.push(c); });
    expect(executed).toEqual([{ capability: "onoff", value: "off" }]);
  });

  it("executes sequentially, not concurrently — a slow command can't reorder a later one's effect", async () => {
    const q = makeQueue();
    q.enqueue("d1", { capability: "onoff", value: "slow" });
    q.enqueue("d2", { capability: "onoff", value: "fast" });
    const order: string[] = [];
    await q.drain(async (subject, cmd) => {
      if (cmd.value === "slow") await new Promise((r) => setTimeout(r, 5));
      order.push(subject);
    });
    expect(order).toEqual(["d1", "d2"]); // sequential — d1 (slow) still finishes before d2 starts, not interleaved
  });
});
