import { describe, it, expect, vi } from "vitest";
import { validateRtspStream, type RtspSocketFactory, type RtspSocketLike } from "./rtsp-handshake.js";

/** A scripted fake RTSP socket: `responses` is consumed in order, one per request written. */
function scriptedSocketFactory(responses: string[], opts: { connectError?: boolean } = {}): RtspSocketFactory {
  return vi.fn(async () => {
    if (opts.connectError) throw new Error("ECONNREFUSED");
    let i = 0;
    let dataCb: ((chunk: string) => void) | null = null;
    const sock: RtspSocketLike = {
      write: () => {
        const resp = responses[i++];
        if (resp !== undefined) queueMicrotask(() => dataCb?.(resp));
      },
      onData: (cb) => {
        dataCb = cb;
      },
      close: () => {},
    };
    return sock;
  });
}

const OPTIONS_OK = "RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY\r\n\r\n";
const SDP_BODY = "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=stream\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n";
const DESCRIBE_OK = `RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Type: application/sdp\r\n\r\n${SDP_BODY}`;
const DESCRIBE_401 = `RTSP/1.0 401 Unauthorized\r\nCSeq: 2\r\nWWW-Authenticate: Digest realm="camera", nonce="abc123"\r\n\r\n`;

describe("validateRtspStream — § STEP 8", () => {
  it("passes for a reachable, unauthenticated camera with a real video SDP line", async () => {
    const socketFactory = scriptedSocketFactory([OPTIONS_OK, DESCRIBE_OK]);
    const result = await validateRtspStream({ url: "rtsp://192.168.1.50:554/stream1", socketFactory });
    expect(result.ok).toBe(true);
    expect(result.codec).toBe("H264");
    expect(result.checklist.every((c) => c.pass)).toBe(true);
  });

  it("passes with Digest auth after a 401 challenge, given correct credentials", async () => {
    const socketFactory = scriptedSocketFactory([OPTIONS_OK, DESCRIBE_401, DESCRIBE_OK]);
    const result = await validateRtspStream({ url: "rtsp://192.168.1.50:554/stream1", username: "admin", password: "secret", socketFactory });
    expect(result.ok).toBe(true);
  });

  it("fails with a plain-English reason when credentials are rejected", async () => {
    const socketFactory = scriptedSocketFactory([OPTIONS_OK, DESCRIBE_401, DESCRIBE_401]);
    const result = await validateRtspStream({ url: "rtsp://192.168.1.50:554/stream1", username: "admin", password: "wrong", socketFactory });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/username or password/i);
    expect(result.reason).not.toMatch(/RTSP\/1\.0|CSeq/); // no protocol internals in the installer-facing reason
  });

  it("fails honestly when the camera requires credentials but none were given", async () => {
    const socketFactory = scriptedSocketFactory([OPTIONS_OK, DESCRIBE_401]);
    const result = await validateRtspStream({ url: "rtsp://192.168.1.50:554/stream1", socketFactory });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/username and password/i);
  });

  it("fails cleanly when the camera is unreachable", async () => {
    const socketFactory = scriptedSocketFactory([], { connectError: true });
    const result = await validateRtspStream({ url: "rtsp://192.168.1.99:554/stream1", socketFactory });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be reached/i);
  });

  it("fails when RTSP isn't actually spoken on that port", async () => {
    const socketFactory = scriptedSocketFactory(["HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"]);
    const result = await validateRtspStream({ url: "rtsp://192.168.1.50:8080/stream1", socketFactory, timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/rtsp does not appear to be enabled/i);
  });

  it("fails when DESCRIBE returns no video media line", async () => {
    const noVideoDescribe = `RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\nv=0\r\nm=audio 0 RTP/AVP 0\r\n`;
    const socketFactory = scriptedSocketFactory([OPTIONS_OK, noVideoDescribe]);
    const result = await validateRtspStream({ url: "rtsp://192.168.1.50:554/audio-only", socketFactory });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no video stream/i);
  });

  it("rejects an invalid URL before ever touching the network", async () => {
    const socketFactory = vi.fn();
    const result = await validateRtspStream({ url: "http://192.168.1.50/stream", socketFactory: socketFactory as any });
    expect(result.ok).toBe(false);
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("never throws when the camera stops responding mid-handshake", async () => {
    const socketFactory: RtspSocketFactory = vi.fn(async () => ({
      write: () => {
        /* never calls back — simulates a hung camera */
      },
      onData: () => {},
      close: () => {},
    }));
    const result = await validateRtspStream({ url: "rtsp://192.168.1.50:554/stream1", socketFactory, timeoutMs: 20 });
    expect(result.ok).toBe(false);
  });
});
