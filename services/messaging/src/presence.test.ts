import { describe, expect, it, vi } from "vitest";
import { InMemoryPresenceStore } from "./presence.js";

describe("InMemoryPresenceStore", () => {
  it("tracks online users per home and dedupes", async () => {
    const p = new InMemoryPresenceStore();
    await p.markOnline("home-1", "user-a");
    await p.markOnline("home-1", "user-a"); // same user, still one
    await p.markOnline("home-1", "user-b");
    await p.markOnline("home-2", "user-c");

    expect((await p.online("home-1")).sort()).toEqual(["user-a", "user-b"]);
    expect(await p.online("home-2")).toEqual(["user-c"]);
    expect(await p.online("home-3")).toEqual([]);
  });

  it("drops a user on markOffline", async () => {
    const p = new InMemoryPresenceStore();
    await p.markOnline("home-1", "user-a");
    await p.markOnline("home-1", "user-b");
    await p.markOffline("home-1", "user-a");
    expect(await p.online("home-1")).toEqual(["user-b"]);
  });

  it("expires entries past their TTL", async () => {
    vi.useFakeTimers();
    try {
      const p = new InMemoryPresenceStore();
      await p.markOnline("home-1", "user-a", 30);
      expect(await p.online("home-1")).toEqual(["user-a"]);
      vi.setSystemTime(Date.now() + 31_000);
      expect(await p.online("home-1")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
