import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { fetchHeosInputNames } from "./avr-heos-inputs.js";

/**
 * A minimal in-process HEOS CLI server replaying the EXACT two-line `browse/browse`
 * sequence (an ack with no `payload`, then the real result) observed against a real Denon
 * AVC-X3800H this session (§ HEOS Input Bridge) — not a guessed shape.
 */
function startFakeHeos(opts: { pid?: string; noPlayers?: boolean } = {}): Promise<{ server: Server; port: number }> {
  const pid = opts.pid ?? "-1261077342";
  return new Promise((resolve) => {
    const server = createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split("\r\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          if (line.startsWith("heos://player/get_players")) {
            const payload = opts.noPlayers
              ? []
              : [{ name: "Living Home Theater", pid, model: "Denon AVC-X3800H" }];
            sock.write(
              `${JSON.stringify({ heos: { command: "player/get_players", result: "success", message: `player_count=${payload.length}` }, payload })}\r\n`,
            );
          } else if (line.startsWith("heos://browse/browse")) {
            sock.write(
              `${JSON.stringify({ heos: { command: "browse/browse", result: "success", message: `command under process&sid=${pid}` } })}\r\n`,
            );
            sock.write(
              `${JSON.stringify({
                heos: { command: "browse/browse", result: "success", message: `sid=${pid}&returned=3&count=3` },
                payload: [
                  { container: "no", mid: "inputs/cable_sat", type: "station", playable: "yes", name: "Apple TV", image_url: "" },
                  { container: "no", mid: "inputs/game", type: "station", playable: "yes", name: "PS5", image_url: "" },
                  { container: "no", mid: "inputs/unknown_future_input", type: "station", playable: "yes", name: "Mystery", image_url: "" },
                ],
              })}\r\n`,
            );
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

describe("fetchHeosInputNames (§ HEOS Input Bridge)", () => {
  it("maps known HEOS Inputs `mid`s to their real Telnet SI tokens, skipping unrecognized ones", async () => {
    const fake = await startFakeHeos();
    try {
      const result = await fetchHeosInputNames("127.0.0.1", { port: fake.port, timeoutMs: 3000 });
      expect(result).toEqual(
        new Map([
          ["SAT/CBL", "Apple TV"],
          ["GAME", "PS5"],
        ]),
      );
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("resolves null when the unit reports no players at all", async () => {
    const fake = await startFakeHeos({ noPlayers: true });
    try {
      const result = await fetchHeosInputNames("127.0.0.1", { port: fake.port, timeoutMs: 3000 });
      expect(result).toBeNull();
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("resolves null (never throws) when nothing is listening on the port", async () => {
    const result = await fetchHeosInputNames("127.0.0.1", { port: 1, timeoutMs: 3000 });
    expect(result).toBeNull();
  });
});
