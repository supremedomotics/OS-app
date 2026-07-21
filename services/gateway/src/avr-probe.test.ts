import { createServer, type Server, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { probeAvr } from "./avr-probe.js";

/** A minimal in-process Denon-style AVR, purpose-built for the probe's own needs (reachability
 * + best-effort zone2 detection) — not the full command-reflecting fake `avr-driver.test.ts`
 * uses, since the probe only ever sends `?` queries during its init burst, never commands. */
function startFakeAvr(opts: { answerZone2?: boolean } = {}): Promise<{ server: Server; port: number; sockets: Set<Socket> }> {
  const answerZone2 = opts.answerZone2 ?? true;
  const sockets = new Set<Socket>();
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split("\r");
        buf = parts.pop() ?? "";
        for (const cmd of parts) {
          if (cmd === "PW?") sock.write("PWON\r");
          else if (cmd === "ZM?") sock.write("ZMON\r");
          else if (cmd === "MV?") sock.write("MV50\r");
          else if (cmd === "MU?") sock.write("MUOFF\r");
          else if (cmd === "SI?") sock.write("SICD\r");
          else if (cmd === "Z2?" && answerZone2) sock.write("Z2ON\r");
          else if (cmd === "Z2MU?" && answerZone2) sock.write("Z2MUOFF\r");
          else if (cmd === "PSTONE CTRL ?") sock.write("PSTONE CTRL ON\r");
          else if (cmd === "PSBAS ?") sock.write("PSBAS 50\r");
          else if (cmd === "PSTRE ?") sock.write("PSTRE 50\r");
          else if (cmd === "MS?") sock.write("MSMOVIE\r");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, sockets });
    });
  });
}

describe("probeAvr", () => {
  it("reports reachable with both zones detected when the receiver answers everything", async () => {
    const fake = await startFakeAvr({ answerZone2: true });
    try {
      const result = await probeAvr(`127.0.0.1:${fake.port}`);
      expect(result.reachable).toBe(true);
      expect(result.error).toBeNull();
      expect(result.zones).toEqual([
        { id: "main", label: "Zone 1", detected: true },
        { id: "zone2", label: "Zone 2", detected: true },
      ]);
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  }, 10_000);

  it("reports zone2 not detected (but stays reachable) when only the main zone answers", async () => {
    const fake = await startFakeAvr({ answerZone2: false });
    try {
      const result = await probeAvr(`127.0.0.1:${fake.port}`);
      expect(result.reachable).toBe(true);
      expect(result.zones).toEqual([
        { id: "main", label: "Zone 1", detected: true },
        { id: "zone2", label: "Zone 2", detected: false },
      ]);
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  }, 10_000);

  it("reports unreachable with a real error and no zones when nothing is listening", async () => {
    // Port 1 is a real closed port on loopback — a genuine ECONNREFUSED, not a mock.
    const result = await probeAvr("127.0.0.1:1");
    expect(result.reachable).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.zones).toEqual([]);
  }, 10_000);

  it("leaves no lingering sockets on the fake server after a probe completes", async () => {
    const fake = await startFakeAvr({ answerZone2: true });
    try {
      await probeAvr(`127.0.0.1:${fake.port}`);
      await new Promise((r) => setTimeout(r, 100)); // let the socket's close event settle
      expect(fake.sockets.size).toBe(0);
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  }, 10_000);
});
