import net from "node:net";
import { buildHeosCommand } from "./heos-codec.js";

const HEOS_PORT = 1255;
const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * Denon Telnet `SI` token each HEOS "Inputs" browse `mid` corresponds to (§ HEOS Input
 * Bridge). Evidenced against a real Denon AVC-X3800H's actual `browse/browse` response —
 * every `mid` below was observed verbatim on real hardware; a `mid` this codebase hasn't
 * actually seen is deliberately left unmapped rather than guessed, so an unrecognized
 * input is silently skipped instead of mislabeled.
 */
const HEOS_INPUT_MID_TO_SI: Record<string, string> = {
  "inputs/tuner": "TUNER",
  "inputs/dvd": "DVD",
  "inputs/bluray": "BD",
  "inputs/tv": "TV",
  "inputs/tvaudio": "TV",
  "inputs/cable_sat": "SAT/CBL",
  "inputs/mediaplayer": "MPLAY",
  "inputs/game": "GAME",
  "inputs/aux1": "AUX1",
  "inputs/aux2": "AUX2",
  "inputs/cd": "CD",
  "inputs/phono": "PHONO",
};

/**
 * § HEOS Input Bridge — an alternate source for renamed AVR input labels, for units whose
 * HTTP AppCommand.xml interface (`avr-http-codec.ts`, this codebase's primary rename
 * source) returns nothing useful — confirmed on a real Denon AVC-X3800H, a recent model
 * where AppCommand.xml no longer reports renames at all. Every Denon/Marantz unit with
 * HEOS Built-in answers on the HEOS CLI port (1255, spec v1.17) independently of whether
 * its AppCommand.xml interface works, and HEOS's own `browse/browse` of its "Inputs"
 * container reports the SAME renamed labels the homeowner set via the Denon/HEOS app or
 * receiver front panel. Verified against real hardware this session:
 * `heos://player/get_players` -> this unit's own pid, then
 * `heos://browse/browse?sid=<pid>` -> its current, real input labels.
 *
 * § Known limitation (deliberately not solved here) — `get_players` is a whole-HOME
 * query (any HEOS unit can answer for every player on the network, not just itself), and
 * its payload carries no per-player IP/host field to disambiguate. This function takes
 * the FIRST player returned by the unit at `host` — correct for the common single-AVR
 * home this was evidenced against, but a home with multiple HEOS-capable units could in
 * principle have this pick the wrong unit's own pid. No worse than not having this
 * source at all (best-effort, never blocks Telnet control), and matches this codebase's
 * existing precedent for accepting a documented multi-unit edge case rather than
 * guessing a fix with no real evidence behind it (see Casambi's own multi-network
 * dedup limitation).
 *
 * Best-effort only: any failure (older/non-HEOS unit, closed port 1255, unexpected
 * response shape) resolves `null` rather than throwing, so callers can freely fall back
 * to AppCommand.xml's result (or no enrichment at all) without special-casing this source.
 */
export async function fetchHeosInputNames(host: string, opts: { timeoutMs?: number; port?: number } = {}): Promise<Map<string, string> | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let stage: "players" | "browse" = "players";
    let buffer = "";
    const socket = net.connect(opts.port ?? HEOS_PORT, host);

    const finish = (result: Map<string, string> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${buildHeosCommand("player", "get_players")}\r\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let msg: { heos?: { command?: string; result?: string }; payload?: unknown };
        try {
          msg = JSON.parse(line.trim());
        } catch {
          continue;
        }
        if (msg.heos?.result !== "success") continue;
        if (stage === "players" && msg.heos.command === "player/get_players") {
          const players = Array.isArray(msg.payload) ? (msg.payload as { pid?: unknown }[]) : [];
          const pid = players[0]?.pid;
          if (pid === undefined) {
            finish(null);
            return;
          }
          stage = "browse";
          socket.write(`${buildHeosCommand("browse", "browse", { sid: String(pid) })}\r\n`);
        } else if (stage === "browse" && msg.heos.command === "browse/browse" && Array.isArray(msg.payload)) {
          // A "command under process" ack for browse/browse has no `payload` at all —
          // that falls through the `Array.isArray` check above and this loop keeps
          // waiting for the real result line, matching real hardware's two-line reply.
          const out = new Map<string, string>();
          for (const item of msg.payload as { mid?: unknown; name?: unknown }[]) {
            const si = typeof item.mid === "string" ? HEOS_INPUT_MID_TO_SI[item.mid] : undefined;
            if (si && typeof item.name === "string" && item.name.trim().length > 0) out.set(si, item.name.trim());
          }
          finish(out.size > 0 ? out : null);
          return;
        }
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}
