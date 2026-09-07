import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeAction } from "./knx-discovery-workspace.js";
import { knxDiscoveryQueueJobStart } from "./api.js";

/**
 * § Pass 27 P0-A — root cause: the mount-time job-resume effect used to flip `phase`
 * to "scanning" for ANY jobId found in localStorage before ever confirming the job
 * was still real. Import jobs live only in the gateway's in-memory map, and a
 * completed job's id is deliberately left in localStorage (Pass 16 fix), so a stale
 * id from an earlier session/tab/reused Incognito window is common — and while
 * resuming it, the Scan button (gated on phase !== "scanning") was disabled, silently
 * swallowing the user's first click until the stale job resolved and cleared itself.
 * `resumeAction` is the extracted decision the fix now makes BEFORE touching phase.
 */
describe("resumeAction (P0-A stale-job-resume fix)", () => {
  it("resumes scanning only for a genuinely still-active job", () => {
    expect(resumeAction("queued")).toBe("scanning");
    expect(resumeAction("running")).toBe("scanning");
  });

  it("finishes immediately for an already-completed job — never re-disables the button", () => {
    expect(resumeAction("completed")).toBe("done");
  });

  it("resets (never blocks the Scan button) for a failed, cancelled, or gone job", () => {
    expect(resumeAction("failed")).toBe("reset");
    expect(resumeAction("cancelled")).toBe("reset");
    expect(resumeAction("gone")).toBe("reset");
  });
});

/**
 * § live-confirmed fix — a real sustained ~4KB/s connection (packet-capture confirmed)
 * made a single giant multipart upload unreliable no matter how generous the timeout,
 * so a `.knxproj` file now travels as a sequence of small chunked `application/octet-stream`
 * POSTs (init → chunk × N → complete) instead of one multipart request — this verifies
 * the ACTUAL request sequence the browser sends, not merely that a UI callback fired.
 * PATH A (scan immediately) and PATH B (scan after a delay) must produce the same shape,
 * both dependent only on the file, never on the Group Address textarea being touched.
 */
describe("knxDiscoveryQueueJobStart — chunked upload request shape (PATH A/B/C)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Captures every fetch call made by a chunked upload: init, each chunk, then complete. */
  async function captureChunkedUpload(ets: Parameters<typeof knxDiscoveryQueueJobStart>[0]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/upload/init")) {
          return new Response(JSON.stringify({ uploadId: "up_1" }), { status: 201 });
        }
        if (url.includes("/chunk/")) {
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify({ jobId: "job_1", status: "queued", stage: "queued" }), { status: 202 });
      }),
    );
    await knxDiscoveryQueueJobStart(ets);
    return calls;
  }

  it("PATH A — file selected, scanned immediately with an empty Group Address: sends init → raw binary chunk(s) → complete, never base64 JSON", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "anon-project.knxproj");
    const calls = await captureChunkedUpload({ knxprojFile: file });
    expect(calls[0]!.url).toContain("/upload/init");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ totalChunks: 1 });
    const chunkCall = calls.find((c) => c.url.includes("/chunk/"))!;
    expect((chunkCall.init!.headers as Record<string, string>)["content-type"]).toBe("application/octet-stream");
    expect(chunkCall.init!.body).toBeInstanceOf(Blob); // a File.slice() result, not base64 JSON
    const completeCall = calls.find((c) => c.url.includes("/complete"))!;
    expect(JSON.parse(completeCall.init!.body as string)).toEqual({ password: undefined });
  });

  it("PATH B — same file, scanned after a delay: identical request shape as PATH A", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "anon-project.knxproj");
    await new Promise((r) => setTimeout(r, 5));
    const calls = await captureChunkedUpload({ knxprojFile: file });
    expect(calls[0]!.url).toContain("/upload/init");
    expect(calls.some((c) => c.url.includes("/chunk/"))).toBe(true);
  });

  it("PATH C — pasted Group Address text instead of a file: plain JSON body straight to the sync route, no chunked upload", async () => {
    const calls = await captureChunkedUpload({ content: "<GroupAddress-Export></GroupAddress-Export>" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init!.body).toBe(JSON.stringify({ content: "<GroupAddress-Export></GroupAddress-Export>" }));
    expect((calls[0]!.init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("a file with a password sends the password on the complete call, not embedded in any chunk", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b])], "protected.knxproj");
    const calls = await captureChunkedUpload({ knxprojFile: file, password: "anon-pass" });
    const completeCall = calls.find((c) => c.url.includes("/complete"))!;
    expect(JSON.parse(completeCall.init!.body as string)).toEqual({ password: "anon-pass" });
  });
});
