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
 * § Pass 27 P0-A.3 — PATH A (select file, scan immediately, empty Group Address) and
 * PATH B (select file, wait, then scan) must produce the IDENTICAL request: a real
 * multipart/form-data body carrying the File object, never a base64 JSON field, and
 * never dependent on the Group Address textarea having been touched. This verifies
 * the actual request the browser would send, not merely that a UI callback fired.
 */
describe("knxDiscoveryQueueJobStart — multipart request shape (PATH A/B/C)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function captureRequest(ets: Parameters<typeof knxDiscoveryQueueJobStart>[0]) {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({ jobId: "job_1", status: "queued", stage: "queued" }), { status: 202 });
      }),
    );
    await knxDiscoveryQueueJobStart(ets);
    return capturedInit!;
  }

  it("PATH A — file selected, scanned immediately with an empty Group Address: sends multipart, not base64 JSON", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "anon-project.knxproj");
    const init = await captureRequest({ knxprojFile: file });
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("knxproj")).toBe(file);
    expect(form.has("password")).toBe(false);
    // The browser sets its own multipart boundary — this code must never override it.
    expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("PATH B — same file, scanned after a delay: identical request shape as PATH A", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "anon-project.knxproj");
    await new Promise((r) => setTimeout(r, 5));
    const init = await captureRequest({ knxprojFile: file });
    const form = init.body as FormData;
    expect(form.get("knxproj")).toBe(file);
  });

  it("PATH C — pasted Group Address text instead of a file: plain JSON body, no FormData", async () => {
    const init = await captureRequest({ content: "<GroupAddress-Export></GroupAddress-Export>" });
    expect(init.body).toBe(JSON.stringify({ content: "<GroupAddress-Export></GroupAddress-Export>" }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("a file with a password carries the password as a separate form field, not embedded in the file part", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b])], "protected.knxproj");
    const init = await captureRequest({ knxprojFile: file, password: "anon-pass" });
    const form = init.body as FormData;
    expect(form.get("password")).toBe("anon-pass");
  });
});
