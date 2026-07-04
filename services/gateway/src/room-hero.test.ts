import { describe, expect, it } from "vitest";
import {
  downloadHeroImage,
  heroImageFromUpload,
  heroImageKey,
  heroImagePath,
  HeroImageError,
  heroKeyword,
  resolvePhotoUrl,
  stockPhotoUrl,
} from "./room-hero.js";

const room = (name: string, areaType = "other") => ({ name, areaType }) as never;

describe("room hero imagery", () => {
  it("maps room names/areas to sensible photo keywords (name overrides area)", () => {
    expect(heroKeyword(room("Conference Room A"))).toBe("conference room");
    expect(heroKeyword(room("Master Bedroom", "bedroom"))).toBe("luxury bedroom");
    expect(heroKeyword(room("Kitchen", "kitchen"))).toBe("kitchen");
    expect(heroKeyword(room("Random Space", "office"))).toBe("office");
    expect(heroKeyword(room("Mystery", "other"))).toBe("modern interior");
  });

  it("builds a deterministic stock URL per room name", () => {
    const a = stockPhotoUrl(room("Lounge"));
    const b = stockPhotoUrl(room("Lounge"));
    expect(a).toBe(b); // stable → same image everywhere
    expect(a).toContain("loremflickr.com");
  });

  it("derives the config key + hub path from the room id", () => {
    expect(heroImageKey("room_1")).toBe("room_hero:room_1");
    expect(heroImagePath("room_1")).toBe("/v1/rooms/room_1/hero-image");
  });

  it("uses Unsplash for a real photo when a key is configured (deterministic pick)", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (u: string, init?: { headers?: Record<string, string> }) => {
      calls.push(u);
      expect(init?.headers?.Authorization).toBe("Client-ID test-key");
      return new Response(
        JSON.stringify({ results: [{ urls: { regular: "https://images.unsplash.com/a" } }, { urls: { regular: "https://images.unsplash.com/b" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const url = await resolvePhotoUrl(room("Living Room"), fakeFetch, "test-key");
    expect(url.startsWith("https://images.unsplash.com/")).toBe(true);
    expect(calls[0]).toContain("api.unsplash.com/search/photos");
  });

  it("uses keyless Openverse when no Unsplash key is set", async () => {
    const fakeFetch = (async (u: string) => {
      expect(u).toContain("api.openverse.org");
      return new Response(JSON.stringify({ results: [{ url: "https://cc.example/room.jpg" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const url = await resolvePhotoUrl(room("Kitchen"), fakeFetch, undefined);
    expect(url).toBe("https://cc.example/room.jpg");
  });

  it("falls back to the stock source when both providers fail", async () => {
    const failing = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const url = await resolvePhotoUrl(room("Kitchen"), failing, undefined);
    expect(url).toContain("loremflickr.com");
  });

  it("downloads and stores image bytes as base64", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const fakeFetch = (async () =>
      new Response(png, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    const stored = await downloadHeroImage(room("Kitchen"), fakeFetch, () => new Date("2026-07-04T00:00:00Z"));
    expect(stored.contentType).toBe("image/png");
    expect(Buffer.from(stored.dataBase64, "base64")).toEqual(png);
    expect(stored.source).toBe("auto");
  });

  it("rejects a non-image or failed response with HeroImageError", async () => {
    const html = (async () =>
      new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    await expect(downloadHeroImage(room("Kitchen"), html)).rejects.toBeInstanceOf(HeroImageError);

    const boom = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    await expect(downloadHeroImage(room("Kitchen"), boom)).rejects.toBeInstanceOf(HeroImageError);
  });

  it("accepts an owner upload as base64 or a data URL", () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const fromB64 = heroImageFromUpload({ dataBase64: bytes.toString("base64"), contentType: "image/jpeg" });
    expect(fromB64.source).toBe("upload");
    expect(Buffer.from(fromB64.dataBase64, "base64")).toEqual(bytes);

    const fromDataUrl = heroImageFromUpload({ dataUrl: `data:image/png;base64,${bytes.toString("base64")}` });
    expect(fromDataUrl.contentType).toBe("image/png");

    expect(() => heroImageFromUpload({})).toThrow(HeroImageError);
    expect(() => heroImageFromUpload({ dataBase64: "AAAA", contentType: "text/plain" })).toThrow(HeroImageError);
  });
});
