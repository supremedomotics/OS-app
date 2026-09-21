import { createHash } from "node:crypto";
import type { CapabilityCommand } from "@supreme/domain-model";

/**
 * PJLink codec (§ PJLink Class 2 native driver). PJLink is JBMIA's ASCII, line-based TCP
 * control protocol for projectors/displays (port 4352 default). Request: `%<class><CMD>
 * <PARAM>\r`. Reply: `%<class><CMD>=<VALUE>\r`. This module implements ONLY the commands
 * documented in the JBMIA "PJLink Specifications (Class 2)" — nothing here is guessed.
 *
 * Implemented (encode + decode, both classes unless noted):
 *   POWR (power on/off/query — 4-state per spec §4.1), INPT (query/set — spec §4.2),
 *   AVMT (av-mute get/set, 10/11/20/21/30/31 semantics — spec §4.3), ERST (6-digit error
 *   status, 0-3 per digit — spec §4.4), LAMP (multi-lamp hours+on/off — spec §4.5), NAME,
 *   INF1 (manufacturer), INF2 (product name), INFO (other info), CLSS (class query),
 *   Class 1 MD5 auth handshake (`PJLINK <seed>\r\n` / `PJLINK ERRA\r\n` greeting, prefix
 *   `MD5(seed+password)` on the FIRST command of the session — spec §5), Class 2 INST
 *   (input list) and FREZ (freeze/unfreeze).
 *
 * Explicitly NOT implemented this pass (documented honestly rather than silently
 * omitted, per task scope — none of these back a Supreme capability or UI control yet):
 *   SNUM (serial number), SVER (software version), INNM per-input-name query beyond what
 *   INST already returns inline is NOT separately queried, IRES/RRES (input/recommended
 *   resolution), FILT/RLMP/RFIL (filter usage + replacement model numbers), SVOL/MVOL
 *   (speaker/mic volume), SECU (security). A production build wiring these should add
 *   them here first (pure encode/decode, no wire-format guessing needed — the class-2
 *   spec table format is identical to what's implemented below) before touching the
 *   driver or capability schema.
 */

export const PJLINK_DEFAULT_PORT = 4352;
export const PJLINK_LINE_TERMINATOR = "\r";

// ── Errors ─────────────────────────────────────────────────────────────────

export type PjlinkErrorCode = "ERRA" | "ERR1" | "ERR2" | "ERR3" | "ERR4";

const PJLINK_ERROR_MESSAGES: Record<PjlinkErrorCode, string> = {
  ERRA: "Authorization error — password rejected",
  ERR1: "Undefined command",
  ERR2: "Out of parameter",
  ERR3: "Unavailable time — the projector cannot execute this command right now (e.g. mid warm-up/cool-down)",
  ERR4: "Projector/display failure",
};

export class PjlinkProtocolError extends Error {
  readonly code: PjlinkErrorCode;
  constructor(code: PjlinkErrorCode) {
    super(PJLINK_ERROR_MESSAGES[code]);
    this.name = "PjlinkProtocolError";
    this.code = code;
  }
}

function checkForError(command: string, value: string): void {
  if (value === "ERRA" || value === "ERR1" || value === "ERR2" || value === "ERR3" || value === "ERR4") {
    throw new PjlinkProtocolError(value);
  }
}

// ── Class 1 MD5 authentication (spec §5) ────────────────────────────────────

/** The unauthenticated greeting is `PJLINK 0\r\n`; the authenticated one is
 * `PJLINK 1 <8-char seed>\r\n`. A reply of `PJLINK ERRA\r\n` means the projector itself
 * rejected the connection outright (rare — most units always send the greeting). */
export type PjlinkGreeting =
  | { authRequired: false }
  | { authRequired: true; seed: string }
  | { authRequired: true; rejected: true };

export function parsePjlinkGreeting(line: string): PjlinkGreeting | null {
  const t = line.trim();
  if (t === "PJLINK ERRA") return { authRequired: true, rejected: true };
  if (t === "PJLINK 0") return { authRequired: false };
  const m = /^PJLINK 1 ([0-9A-Fa-f]{8})$/.exec(t);
  if (m && m[1]) return { authRequired: true, seed: m[1] };
  return null;
}

/** MD5(seed + password), lowercase hex — prefixed onto the FIRST command token sent
 * after an authenticated greeting (spec §5: `<32-char-md5-hex><command>`). */
export function pjlinkAuthDigest(seed: string, password: string): string {
  return createHash("md5").update(seed + password, "utf8").digest("hex");
}

// ── Request encoding ─────────────────────────────────────────────────────────

export type PjlinkClass = "1" | "2";

function frame(pjClass: PjlinkClass, cmd: string, param: string): string {
  return `%${pjClass}${cmd} ${param}${PJLINK_LINE_TERMINATOR}`;
}

export const PJLINK_SOURCE_TYPE = { RGB: 1, VIDEO: 2, DIGITAL: 3, STORAGE: 4, NETWORK: 5 } as const;

export interface PjlinkInputRef {
  source: 1 | 2 | 3 | 4 | 5;
  number: number;
}

export function inputToken(input: PjlinkInputRef): string {
  return `${input.source}${input.number}`;
}

export function parseInputToken(token: string): PjlinkInputRef | null {
  const m = /^([1-5])([1-9])$/.exec(token.trim());
  if (!m) return null;
  return { source: Number(m[1]) as PjlinkInputRef["source"], number: Number(m[2]) };
}

/** Queries needed to fully refresh a projector's state — used by the driver's poller.
 * `pjClass` picks which class prefix to send (a device that only answers Class 1
 * ignores/errors a Class-2-only command; the driver negotiates the class once via
 * `CLSS?` and never sends Class-2-only commands to a Class-1-only unit). */
export function buildPollCommands(pjClass: PjlinkClass): string[] {
  const base = [
    frame(pjClass, "POWR", "?"),
    frame(pjClass, "INPT", "?"),
    frame(pjClass, "AVMT", "?"),
    frame(pjClass, "ERST", "?"),
    frame(pjClass, "LAMP", "?"),
  ];
  if (pjClass === "2") base.push(frame(pjClass, "FREZ", "?"));
  return base;
}

export function buildInfoCommands(pjClass: PjlinkClass): string[] {
  const cmds = [frame(pjClass, "INF1", "?"), frame(pjClass, "INF2", "?"), frame(pjClass, "INFO", "?"), frame(pjClass, "NAME", "?")];
  if (pjClass === "2") cmds.push(frame(pjClass, "INST", "?"));
  return cmds;
}

export function buildClassQuery(): string {
  // CLSS itself is defined identically in both classes; Class 1 is the safe probe.
  return frame("1", "CLSS", "?");
}

/** Encode a Supreme display command into PJLink request line(s). `pjClass` gates
 * Class-2-only commands (INPT with an input NOT in a Class-1 unit's narrower set is
 * still valid — Class 1 and Class 2 share the same INPT wire format; only INST/FREZ are
 * genuinely Class-2-only). Returns `null` for an unsupported action/class combination. */
export function commandToPjlink(command: CapabilityCommand, pjClass: PjlinkClass): string[] | null {
  if (command.capability !== "display") return null;
  switch (command.action) {
    case "on":
      return [frame(pjClass, "POWR", "1")];
    case "off":
      return [frame(pjClass, "POWR", "0")];
    case "setInput":
      return command.input ? [frame(pjClass, "INPT", inputToken(command.input))] : null;
    case "muteVideo":
      return [frame(pjClass, "AVMT", "11")];
    case "unmuteVideo":
      return [frame(pjClass, "AVMT", "10")];
    case "muteAudio":
      return [frame(pjClass, "AVMT", "21")];
    case "unmuteAudio":
      return [frame(pjClass, "AVMT", "20")];
    case "muteAv":
      return [frame(pjClass, "AVMT", "31")];
    case "unmuteAv":
      return [frame(pjClass, "AVMT", "30")];
    case "freeze":
      return pjClass === "2" ? [frame(pjClass, "FREZ", "1")] : null;
    case "unfreeze":
      return pjClass === "2" ? [frame(pjClass, "FREZ", "0")] : null;
    default:
      return null;
  }
}

// ── Reply decoding ────────────────────────────────────────────────────────────

export type PjlinkPowerState = "off" | "warming" | "on" | "cooling";

export type PjlinkAvMute = { video: boolean | null; audio: boolean | null };

export type PjlinkErrorStatus = {
  fan: 0 | 1 | 2 | 3;
  lamp: 0 | 1 | 2 | 3;
  temperature: 0 | 1 | 2 | 3;
  coverOpen: 0 | 1 | 2 | 3;
  filter: 0 | 1 | 2 | 3;
  other: 0 | 1 | 2 | 3;
};

export type PjlinkUpdate =
  | { kind: "power"; state: PjlinkPowerState }
  | { kind: "input"; input: PjlinkInputRef }
  | { kind: "inputList"; inputs: PjlinkInputRef[] }
  | { kind: "avmt"; mute: PjlinkAvMute }
  | { kind: "erst"; status: PjlinkErrorStatus }
  | { kind: "lamp"; lamps: { hours: number; on: boolean }[] }
  | { kind: "freeze"; frozen: boolean }
  | { kind: "manufacturer"; value: string }
  | { kind: "product"; value: string }
  | { kind: "otherInfo"; value: string }
  | { kind: "name"; value: string }
  | { kind: "class"; value: PjlinkClass };

/** Parse ONE reply line (`%<class><CMD>=<VALUE>`). Throws {@link PjlinkProtocolError}
 * for an `ERRA`/`ERR1`/`ERR2`/`ERR3`/`ERR4` value — callers decide per-command whether
 * that's fatal (auth) or just "this one poll item failed." Returns `null` for a line
 * this codec doesn't recognize (unimplemented Class 2 command, or malformed) — never
 * thrown for an unrecognized-but-not-error line, matching this fleet's "trace it,
 * don't crash the link" posture (see avr-codec.ts's parseAvrLine doc). */
export function parsePjlinkLine(line: string): PjlinkUpdate | null {
  const t = line.trim();
  const m = /^%[12]([A-Z0-9]+)=(.*)$/.exec(t);
  if (!m) return null;
  const [, cmd, rawValue] = m;
  const value = (rawValue ?? "").trim();
  switch (cmd) {
    case "POWR": {
      checkForError(cmd, value);
      const map: Record<string, PjlinkPowerState> = { "0": "off", "1": "on", "2": "cooling", "3": "warming" };
      const state = map[value];
      return state ? { kind: "power", state } : null;
    }
    case "INPT": {
      checkForError(cmd, value);
      const input = parseInputToken(value);
      return input ? { kind: "input", input } : null;
    }
    case "INST": {
      checkForError(cmd, value);
      const inputs = value
        .split(" ")
        .map((tok) => parseInputToken(tok))
        .filter((x): x is PjlinkInputRef => x !== null);
      return { kind: "inputList", inputs };
    }
    case "AVMT": {
      checkForError(cmd, value);
      // 1x = video mute, 2x = audio mute, 3x = both; trailing digit 0=off/1=on for
      // that specific target only — the OTHER channel's mute state is left unreported
      // by this exact reply (spec §4.3 table) and must not be assumed unchanged blindly
      // by the caller without also tracking the last-known value (driver's job, not the
      // codec's — this returns exactly what this one reply says, nothing inferred).
      if (value === "10") return { kind: "avmt", mute: { video: false, audio: null } };
      if (value === "11") return { kind: "avmt", mute: { video: true, audio: null } };
      if (value === "20") return { kind: "avmt", mute: { video: null, audio: false } };
      if (value === "21") return { kind: "avmt", mute: { video: null, audio: true } };
      if (value === "30") return { kind: "avmt", mute: { video: false, audio: false } };
      if (value === "31") return { kind: "avmt", mute: { video: true, audio: true } };
      return null;
    }
    case "ERST": {
      checkForError(cmd, value);
      if (!/^[0-3]{6}$/.test(value)) return null;
      const digits = value.split("").map((d) => Number(d) as 0 | 1 | 2 | 3);
      return {
        kind: "erst",
        status: {
          fan: digits[0] ?? 0,
          lamp: digits[1] ?? 0,
          temperature: digits[2] ?? 0,
          coverOpen: digits[3] ?? 0,
          filter: digits[4] ?? 0,
          other: digits[5] ?? 0,
        },
      };
    }
    case "LAMP": {
      checkForError(cmd, value);
      // "<hours1> <state1> <hours2> <state2> ..." — spec §4.5, pairs of tokens.
      const tokens = value.split(" ").filter((s) => s.length > 0);
      const lamps: { hours: number; on: boolean }[] = [];
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        const hours = Number(tokens[i]);
        if (Number.isNaN(hours)) continue;
        lamps.push({ hours, on: tokens[i + 1] === "1" });
      }
      return { kind: "lamp", lamps };
    }
    case "FREZ": {
      checkForError(cmd, value);
      if (value === "0") return { kind: "freeze", frozen: false };
      if (value === "1") return { kind: "freeze", frozen: true };
      return null;
    }
    case "INF1":
      checkForError(cmd, value);
      return { kind: "manufacturer", value };
    case "INF2":
      checkForError(cmd, value);
      return { kind: "product", value };
    case "INFO":
      checkForError(cmd, value);
      return { kind: "otherInfo", value };
    case "NAME":
      checkForError(cmd, value);
      return { kind: "name", value };
    case "CLSS": {
      checkForError(cmd, value);
      // Some real-world units reply "2" instead of the spec-literal "%2CLSS=2" digit-only
      // form vs. a leading class marker — normalize by taking the last character digit.
      const digit = value.trim().slice(-1);
      return digit === "1" || digit === "2" ? { kind: "class", value: digit } : null;
    }
    default:
      return null;
  }
}

/** Label used by the driver/capability layer for an input the device hasn't (or can't,
 * Class 1) name via `INST` — never a guessed model-specific string. */
export function fallbackInputLabel(input: PjlinkInputRef): string {
  const names: Record<number, string> = { 1: "RGB", 2: "Video", 3: "Digital", 4: "Storage", 5: "Network" };
  return `${names[input.source] ?? "Input"} ${input.number}`;
}
