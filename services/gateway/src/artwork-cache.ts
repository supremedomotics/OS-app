import type { DeviceId } from "@supreme/domain-model";
import type { MediaArtwork } from "@supreme/integration-layer";

export interface ArtworkCacheOptions {
  /** Max entries retained (LRU eviction) — bounds memory for a home with many
   * concurrently-viewed media players. Default 64. */
  maxEntries?: number;
  /** How long a cached fetch is served before the source is hit again. Default 60s,
   * matching the artwork route's existing `Cache-Control: max-age=60`. */
  ttlMs?: number;
}

interface CacheEntry {
  artwork: MediaArtwork;
  fetchedAt: number;
}

/**
 * In-process artwork cache fronting `SupremeIntegrationLayer.getArtwork` (§ Universal
 * AVR Framework — Artwork Cache). Now-playing UI polls the same device every few
 * seconds; without this, every poll re-fetches full image bytes from the physical
 * device, its bridge session (Apple TV/pyatv), or a remote CDN. `MediaArtwork` carries
 * no version/etag, so a TTL — not a fabricated content hash — is the honest staleness
 * bound. Concurrent requests for the same device during a miss share one in-flight
 * fetch instead of stampeding the source.
 */
export class ArtworkCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly entries = new Map<DeviceId, CacheEntry>();
  private readonly inflight = new Map<DeviceId, Promise<MediaArtwork | null>>();

  constructor(opts: ArtworkCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 64;
    this.ttlMs = opts.ttlMs ?? 60_000;
  }

  async get(deviceId: DeviceId, fetch: () => Promise<MediaArtwork | null>): Promise<MediaArtwork | null> {
    const cached = this.entries.get(deviceId);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      this.entries.delete(deviceId); // re-insert to refresh LRU recency
      this.entries.set(deviceId, cached);
      return cached.artwork;
    }
    const pending = this.inflight.get(deviceId);
    if (pending) return pending;
    const promise = fetch()
      .then((artwork) => {
        if (artwork) this.put(deviceId, artwork);
        return artwork;
      })
      .finally(() => {
        this.inflight.delete(deviceId);
      });
    this.inflight.set(deviceId, promise);
    return promise;
  }

  /** Drop a device's cached art immediately (e.g. its now-playing track just changed),
   * so the next request isn't served stale bytes for up to the remaining TTL. */
  invalidate(deviceId: DeviceId): void {
    this.entries.delete(deviceId);
  }

  get size(): number {
    return this.entries.size;
  }

  private put(deviceId: DeviceId, artwork: MediaArtwork): void {
    this.entries.delete(deviceId);
    this.entries.set(deviceId, { artwork, fetchedAt: Date.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
