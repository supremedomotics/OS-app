import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import net from "node:net";
import { validateRtspStream } from "./rtsp-handshake.js";

/**
 * Real TLS transport tests (§ TLS transport) — a genuine `tls.createServer()` fixture with a
 * real, freshly-generated self-signed certificate (via the system `openssl`, the same tool every
 * LAN camera's own firmware uses to mint its cert), exercised through `validateRtspStream` with
 * NO `socketFactory` override — i.e. the real scheme-based transport selection in
 * `rtsp-handshake.ts` is what's under test here, not an injected fake.
 */

const OPTIONS_OK = "RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY\r\n\r\n";
const SDP_BODY = "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=stream\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n";
const DESCRIBE_OK = `RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Type: application/sdp\r\n\r\n${SDP_BODY}`;
const DESCRIBE_401 = `RTSP/1.0 401 Unauthorized\r\nCSeq: 2\r\nWWW-Authenticate: Digest realm="camera", nonce="abc123"\r\n\r\n`;

let certDir: string;
let keyPath: string;
let certPath: string;

beforeAll(() => {
  certDir = mkdtempSync(path.join(tmpdir(), "rtsp-tls-fixture-"));
  keyPath = path.join(certDir, "key.pem");
  certPath = path.join(certDir, "cert.pem");
  // A real self-signed cert, exactly the shape a LAN IP camera's own firmware mints for itself —
  // no CA, no chain, just a keypair and an X.509 cert over it.
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=test-camera.local",
  ]);
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

/** A minimal scripted RTSP-over-TLS server: replies with `responses[i]` to the i-th request it
 * receives, terminating on TLS with the fixture's self-signed cert. */
function startTlsFixtureServer(responses: string[]): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = tls.createServer({ key: readKey(), cert: readCert() }, (socket) => {
      let i = 0;
      socket.on("data", () => {
        const resp = responses[i++];
        if (resp !== undefined) socket.write(resp);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

function readKey(): Buffer {
  return readFileSync(keyPath);
}
function readCert(): Buffer {
  return readFileSync(certPath);
}

describe("rtsps:// TLS transport — § TLS transport", () => {
  it("passes a DESCRIBE over a real TLS connection with a self-signed cert (accepted, not CA-validated)", async () => {
    const { port, close } = await startTlsFixtureServer([OPTIONS_OK, DESCRIBE_OK]);
    try {
      const result = await validateRtspStream({ url: `rtsps://127.0.0.1:${port}/stream1` });
      expect(result.ok).toBe(true);
      expect(result.codec).toBe("H264");
    } finally {
      await close();
    }
  });

  it("completes a Digest auth challenge/retry over TLS", async () => {
    const { port, close } = await startTlsFixtureServer([OPTIONS_OK, DESCRIBE_401, DESCRIBE_OK]);
    try {
      const result = await validateRtspStream({
        url: `rtsps://127.0.0.1:${port}/stream1`,
        username: "admin",
        password: "secret",
      });
      expect(result.ok).toBe(true);
    } finally {
      await close();
    }
  });

  it("fails cleanly, with an installer-safe reason, when nothing is listening (connection refused)", async () => {
    const result = await validateRtspStream({ url: "rtsps://127.0.0.1:1/stream1", timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be reached/i);
    expect(result.reason).not.toMatch(/ECONNREFUSED|SSL|TLS|OpenSSL/i);
  });

  it("fails cleanly, with an installer-safe reason, on a TLS handshake failure (peer is not TLS at all)", async () => {
    // A plain TCP server that never speaks TLS — the client's TLS handshake will fail/reset.
    const plainServer = net.createServer((socket) => socket.on("data", () => socket.end()));
    await new Promise<void>((resolve) => plainServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = plainServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const result = await validateRtspStream({ url: `rtsps://127.0.0.1:${port}/stream1`, timeoutMs: 1000 });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/could not be reached/i);
      expect(result.reason).not.toMatch(/SSL|TLS|OpenSSL|wrong version number/i);
    } finally {
      await new Promise((resolve) => plainServer.close(() => resolve(undefined)));
    }
  });

  it("rejects an unreachable local-network rtsps:// host validation the same as rtsp://", async () => {
    const result = await validateRtspStream({ url: "rtsps://8.8.8.8/stream1", timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/local-network|not valid/i);
  });
});
