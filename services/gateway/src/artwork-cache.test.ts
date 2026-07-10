import type { DeviceId } from "@supreme/domain-model";
import type { MediaArtwork } from "@supreme/integration-layer";
import { describe, expect, it } from "vitest";
import { ArtworkCache } from "./artwork-cache.js";

const art = (tag: string): MediaArtwork => ({ contentType: "image/jpeg", data: new TextEncoder().encode(tag) });

describe("ArtworkCache", () => {
  it("serves a cache hit without re-invoking the fetcher", async () => {
    const cache = new ArtworkCache({ ttlMs: 60_000 });
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return art("v1");
    };
    const dev = "dev-1" as DeviceId;
    const a = await cache.get(dev, fetch);
    const b = await cache.get(dev, fetch);
    expect(a).toEqual(art("v1"));
    expect(b).toEqual(art("v1"));
    expect(calls).toBe(1);
  });

  it("re-fetches once the TTL expires", async () => {
    const cache = new ArtworkCache({ ttlMs: 10 });
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return art(`v${calls}`);
    };
    const dev = "dev-1" as DeviceId;
    await cache.get(dev, fetch);
    await new Promise((r) => setTimeout(r, 20));
    const second = await cache.get(dev, fetch);
    expect(second).toEqual(art("v2"));
    expect(calls).toBe(2);
  });

  it("deduplicates concurrent misses into one in-flight fetch", async () => {
    const cache = new ArtworkCache();
    let calls = 0;
    const fetch = () =>
      new Promise<MediaArtwork | null>((resolve) => {
        calls += 1;
        setTimeout(() => resolve(art("v1")), 10);
      });
    const dev = "dev-1" as DeviceId;
    const [a, b, c] = await Promise.all([cache.get(dev, fetch), cache.get(dev, fetch), cache.get(dev, fetch)]);
    expect(calls).toBe(1);
    expect(a).toEqual(art("v1"));
    expect(b).toEqual(art("v1"));
    expect(c).toEqual(art("v1"));
  });

  it("does not cache a null result — the next request retries", async () => {
    const cache = new ArtworkCache();
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return null;
    };
    const dev = "dev-1" as DeviceId;
    await cache.get(dev, fetch);
    await cache.get(dev, fetch);
    expect(calls).toBe(2);
  });

  it("invalidate() forces the next request past the cache immediately", async () => {
    const cache = new ArtworkCache({ ttlMs: 60_000 });
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return art(`v${calls}`);
    };
    const dev = "dev-1" as DeviceId;
    await cache.get(dev, fetch);
    cache.invalidate(dev);
    const second = await cache.get(dev, fetch);
    expect(second).toEqual(art("v2"));
    expect(calls).toBe(2);
  });

  it("evicts the least-recently-used entry once maxEntries is exceeded", async () => {
    const cache = new ArtworkCache({ maxEntries: 2, ttlMs: 60_000 });
    await cache.get("dev-1" as DeviceId, async () => art("1"));
    await cache.get("dev-2" as DeviceId, async () => art("2"));
    // Touch dev-1 so dev-2 becomes the least-recently-used entry.
    await cache.get("dev-1" as DeviceId, async () => art("1"));
    await cache.get("dev-3" as DeviceId, async () => art("3"));
    expect(cache.size).toBe(2);

    let calls = 0;
    const refetch = async () => {
      calls += 1;
      return art("2-again");
    };
    await cache.get("dev-2" as DeviceId, refetch); // evicted — must re-fetch
    expect(calls).toBe(1);
  });

  it("keeps devices independent — a miss on one never touches another's cached entry", async () => {
    const cache = new ArtworkCache({ ttlMs: 60_000 });
    await cache.get("dev-1" as DeviceId, async () => art("keep-me"));
    let calls = 0;
    await cache.get("dev-2" as DeviceId, async () => {
      calls += 1;
      return art("dev-2");
    });
    const still = await cache.get("dev-1" as DeviceId, async () => {
      throw new Error("should not be called — dev-1 is still cached");
    });
    expect(still).toEqual(art("keep-me"));
    expect(calls).toBe(1);
  });
});
