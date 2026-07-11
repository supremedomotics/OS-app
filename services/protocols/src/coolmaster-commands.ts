import { CoolMasterUnsupportedCommandError } from "./coolmaster-errors.js";
import type { CoolMasterModeWord, CoolMasterUid } from "./coolmaster-types.js";

/**
 * ASCII_IF command string builders — one function per documented command
 * (docs/coolmaster/CoolMaster_Core_Reference_Part4_v1.0.txt), each tagged with a
 * confidence level so a caller (and docs/coolmaster/README.md) can see exactly which
 * commands are wire-verified vs best-effort-inferred:
 *
 *  - HIGH:   verb + syntax match this codebase's prior, test-validated driver, or are
 *            unambiguous single-word ASCII_IF verbs the reference docs name directly.
 *  - MEDIUM: the verb/command name is documented, but an argument's exact spelling
 *            (e.g. filt's reset argument) is this driver's best-effort inference from
 *            protocol convention, not a confirmed example.
 *  - LOW:    the command's EXISTENCE is documented by name only ("wh", "main", "vam",
 *            "group") with no syntax at all (docs/coolmaster Part 4 §19-24: "Implement
 *            if supported by installation" / "Document: Create - Delete - Update -
 *            Validation" with no actual verbs given). Implemented here by inferring the
 *            same `<verb> <uid> [args]` grammar every OTHER documented command uses
 *            (on/off/temp/mode all follow verb-then-uid), which is the protocol's one
 *            consistent pattern — but genuinely unconfirmed against a specific example.
 *  - UNIMPLEMENTED: "va" (Virtual Address support, Part 4 §25) is named with no
 *            behavior description beyond "Maintain persistent mapping" — not enough to
 *            infer a command grammar from at all, so it is NOT implemented. Listed in
 *            docs/coolmaster/README.md Limitations rather than silently omitted.
 */

export type CoolMasterCommandConfidence = "high" | "medium" | "low";

export interface CoolMasterCommandSpec {
  name: string;
  confidence: CoolMasterCommandConfidence;
  /** Whether a transient failure sending this command is safe to retry automatically.
   * false for anything that could double-apply an action if replayed blindly (group
   * membership changes) — everything else here is idempotent (re-sending "on" or
   * "temp 22" twice has the same end state), so true is the default. */
  retryable: boolean;
}

function assertUid(uid: string): void {
  if (!uid || uid.trim().length === 0) throw new CoolMasterUnsupportedCommandError("(missing uid)");
}

// ── HIGH confidence: core on/off + mode + setpoint (matches prior validated driver) ──

export const CMD_ON: CoolMasterCommandSpec = { name: "on", confidence: "high", retryable: true };
export function cmdOn(uid: CoolMasterUid): string {
  assertUid(uid);
  return `on ${uid}`;
}

export const CMD_OFF: CoolMasterCommandSpec = { name: "off", confidence: "high", retryable: true };
export function cmdOff(uid: CoolMasterUid): string {
  assertUid(uid);
  return `off ${uid}`;
}

export const CMD_ALLON: CoolMasterCommandSpec = { name: "allon", confidence: "high", retryable: true };
export function cmdAllOn(line?: string): string {
  return line ? `allon ${line}` : "allon";
}

export const CMD_ALLOFF: CoolMasterCommandSpec = { name: "alloff", confidence: "high", retryable: true };
export function cmdAllOff(line?: string): string {
  return line ? `alloff ${line}` : "alloff";
}

export const CMD_MODE: CoolMasterCommandSpec = { name: "mode", confidence: "high", retryable: true };
/** The mode word itself IS the command (e.g. "cool L1.100") — matches the prior driver
 * and docs/coolmaster Part 4 §5-9. Implicitly turns the unit on, same as real hardware. */
export function cmdMode(uid: CoolMasterUid, mode: CoolMasterModeWord): string {
  assertUid(uid);
  return `${mode} ${uid}`;
}

export const CMD_TEMP: CoolMasterCommandSpec = { name: "temp", confidence: "high", retryable: true };
export function cmdTemp(uid: CoolMasterUid, celsius: number): string {
  assertUid(uid);
  return `temp ${uid} ${celsius}`;
}

// ── HIGH confidence: read-only / discovery verbs (single documented words) ──────────

export const CMD_LS: CoolMasterCommandSpec = { name: "ls", confidence: "high", retryable: true };
export function cmdLs(): string {
  return "ls";
}

export const CMD_LS2: CoolMasterCommandSpec = { name: "ls2", confidence: "high", retryable: true };
export function cmdLs2(): string {
  return "ls2";
}

export const CMD_STAT: CoolMasterCommandSpec = { name: "stat", confidence: "high", retryable: true };
export function cmdStat(): string {
  return "stat";
}

export const CMD_QUERY: CoolMasterCommandSpec = { name: "query", confidence: "high", retryable: true };
export function cmdQuery(uid: CoolMasterUid): string {
  assertUid(uid);
  return `query ${uid}`;
}

export const CMD_INFO: CoolMasterCommandSpec = { name: "info", confidence: "high", retryable: true };
export function cmdInfo(): string {
  return "info";
}

export const CMD_LINE: CoolMasterCommandSpec = { name: "line", confidence: "high", retryable: true };
export function cmdLine(): string {
  return "line";
}

// ── MEDIUM confidence: documented verb, best-effort argument spelling ──────────────

export const CMD_FSPEED: CoolMasterCommandSpec = { name: "fspeed", confidence: "medium", retryable: true };
export function cmdFanSpeed(uid: CoolMasterUid, speed: string): string {
  assertUid(uid);
  return `fspeed ${uid} ${speed}`;
}

export const CMD_SWING: CoolMasterCommandSpec = { name: "swing", confidence: "medium", retryable: true };
export function cmdSwing(uid: CoolMasterUid, position: string): string {
  assertUid(uid);
  return `swing ${uid} ${position}`;
}

export const CMD_FILT_RESET: CoolMasterCommandSpec = { name: "filt", confidence: "medium", retryable: false };
/** Clears the filter-clean warning. "reset" is this driver's best-effort argument
 * (protocol convention: <verb> <uid> <sub-action>) — not confirmed against a specific
 * documented example. Not retried automatically (a filter reset should be an explicit,
 * once-only installer/homeowner action, not silently replayed on a transient failure). */
export function cmdFilterReset(uid: CoolMasterUid): string {
  assertUid(uid);
  return `filt ${uid} reset`;
}

export const CMD_LOCK: CoolMasterCommandSpec = { name: "lock", confidence: "medium", retryable: true };
export function cmdLock(uid: CoolMasterUid, locked: boolean): string {
  assertUid(uid);
  return `lock ${uid} ${locked ? "on" : "off"}`;
}

export const CMD_INHIBIT: CoolMasterCommandSpec = { name: "inhibit", confidence: "medium", retryable: true };
export function cmdInhibit(uid: CoolMasterUid, inhibited: boolean): string {
  assertUid(uid);
  return `inhibit ${uid} ${inhibited ? "on" : "off"}`;
}

// ── LOW confidence: named-only secondary device types (water heater / main / vam / group) ──

export const CMD_WH: CoolMasterCommandSpec = { name: "wh", confidence: "low", retryable: true };
/** Water heater on/off. Inferred grammar (verb + uid), matching every other documented
 * command — docs/coolmaster Part 4 §19 names "wh" and says only "Water heater. Expose
 * separate climate/water-heater entity." with no syntax. */
export function cmdWaterHeaterPower(uid: CoolMasterUid, on: boolean): string {
  assertUid(uid);
  return `wh ${uid} ${on ? "on" : "off"}`;
}
export function cmdWaterHeaterTemp(uid: CoolMasterUid, celsius: number): string {
  assertUid(uid);
  return `wh ${uid} temp ${celsius}`;
}

export const CMD_MAIN: CoolMasterCommandSpec = { name: "main", confidence: "low", retryable: true };
/** Main controller on/off. Part 4 §20: "Main controller command. Implement if supported
 * by installation." — no syntax given; same inferred grammar as above. */
export function cmdMainControllerPower(uid: CoolMasterUid, on: boolean): string {
  assertUid(uid);
  return `main ${uid} ${on ? "on" : "off"}`;
}

export const CMD_VAM: CoolMasterCommandSpec = { name: "vam", confidence: "low", retryable: true };
/** Ventilation (VAM) unit on/off + fan speed. Part 4 §21: "Ventilation unit. Create
 * dedicated ventilation entity." — no syntax given; inferred grammar. */
export function cmdVentilationPower(uid: CoolMasterUid, on: boolean): string {
  assertUid(uid);
  return `vam ${uid} ${on ? "on" : "off"}`;
}
export function cmdVentilationFanSpeed(uid: CoolMasterUid, speed: string): string {
  assertUid(uid);
  return `vam ${uid} fspeed ${speed}`;
}

export const CMD_GROUP: CoolMasterCommandSpec = { name: "group", confidence: "low", retryable: false };
/** Group on/off — controls every member unit via a single command. Part 4 §24 confirms
 * groups support "Discovery - Commands - State aggregation" but not the exact create/
 * delete/control verbs; power control via `group <id> on|off` is inferred from the same
 * grammar as `wh`/`main`/`vam` above. Group MEMBERSHIP (create/add/remove) is NOT
 * implemented — genuinely no basis to infer that syntax — see docs/coolmaster/README.md
 * Limitations; groups discovered on the gateway are still fully controllable here. */
export function cmdGroupPower(groupId: string, on: boolean): string {
  if (!groupId) throw new CoolMasterUnsupportedCommandError("(missing group id)");
  return `group ${groupId} ${on ? "on" : "off"}`;
}

/**
 * "va" (Virtual Address support, docs/coolmaster Part 4 §25) is UNIMPLEMENTED. The
 * reference docs name it and say only "Maintain persistent mapping" — not a command
 * grammar, a response shape, or even a clear statement of what a VA command DOES,
 * so there is no defensible basis to infer syntax from (unlike wh/main/vam/group, which
 * at least specify a clear real-world action this driver can grammar-match against the
 * rest of the protocol). Calling code should not attempt to synthesize a "va" command;
 * see docs/coolmaster/README.md Limitations for the explicit callout this instruction
 * set requires ("if any documented feature is not implemented, explicitly list it with
 * the reason instead of silently omitting it").
 */
export function cmdVirtualAddress(): never {
  throw new CoolMasterUnsupportedCommandError(
    "va (Virtual Address) — not implemented; the reference docs name this command with no syntax or behavior detail to implement against",
  );
}
