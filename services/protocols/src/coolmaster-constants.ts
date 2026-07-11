import type { CoolMasterFanSpeed, CoolMasterModeWord, ResolvedCoolMasterConfig } from "./coolmaster-types.js";

/** ASCII_IF TCP control port (CoolMasterNet default; docs/coolmaster Core Reference §5). */
export const DEFAULT_ASCII_PORT = 10102;

/** Local REST API port (docs/coolmaster/CoolMaster_Core_Reference_Part5_v1.0.txt §1). */
export const DEFAULT_REST_PORT = 10103;

export const DEFAULT_POLL_MS = 10_000;
export const DEFAULT_SLOW_POLL_MS = 300_000;
export const DEFAULT_DISCOVERY_INTERVAL_MS = 1_800_000;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_RETRY_COUNT = 3;
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 60_000;

export const DEFAULT_CONFIG: Omit<ResolvedCoolMasterConfig, "host" | "createSocket" | "fetchImpl"> = {
  protocol: "auto",
  asciiPort: DEFAULT_ASCII_PORT,
  restPort: DEFAULT_REST_PORT,
  pollMs: DEFAULT_POLL_MS,
  slowPollMs: DEFAULT_SLOW_POLL_MS,
  discoveryIntervalMs: DEFAULT_DISCOVERY_INTERVAL_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  retryCount: DEFAULT_RETRY_COUNT,
  backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs: DEFAULT_BACKOFF_MAX_MS,
  debug: false,
};

/** The five real ASCII_IF mode command words — each one IS the command that both sets
 * the mode and (implicitly) turns the unit on, per docs/coolmaster Part 4 §5-9 and the
 * prior driver's validated behaviour. */
export const MODE_WORDS: readonly CoolMasterModeWord[] = ["cool", "heat", "auto", "dry", "fan"];

/** Supreme's temperature.mode enum has no "dry" — the closest analogue is "cool" (a
 * dehumidify pass is a cooling-adjacent cycle); documented explicitly rather than
 * silently dropped, matching the prior driver's same documented choice. */
export const SUPREME_MODE_FROM_COOLMASTER: Record<CoolMasterModeWord, "heat" | "cool" | "auto" | "fan_only"> = {
  heat: "heat",
  cool: "cool",
  auto: "auto",
  fan: "fan_only",
  dry: "cool",
};

/** Common fan-speed vocabulary seen across CoolMasterNet-fronted brands. A given unit's
 * ACTUAL supported subset is discovered (query/ls2), never assumed from this list — this
 * is only the superset used to validate/normalize a reported word's casing. */
export const KNOWN_FAN_SPEEDS: readonly CoolMasterFanSpeed[] = ["Auto", "Low", "Med", "High", "Top"];

/** ASCII_IF line terminator the gateway expects after each command (verified against the
 * prior driver + PRM: commands are CR-terminated, responses CRLF-terminated). */
export const ASCII_COMMAND_TERMINATOR = "\r";

/** The bridge's interactive prompt character that prefixes/suffixes unsolicited output
 * and command echoes on some firmware — stripped from parsed lines. */
export const ASCII_PROMPT = ">";

/** REST API version path segments, most-preferred first — v2 is native JSON (preferred
 * per docs/coolmaster Part 5 §1/§4), v1 wraps ASCII_IF commands through REST as a
 * fallback for gateways/firmware where v2 isn't available. */
export const REST_API_VERSIONS = ["v2.0", "v1.0"] as const;
export type CoolMasterRestApiVersion = (typeof REST_API_VERSIONS)[number];

/** HTTP status codes the reference docs explicitly call out to handle
 * (docs/coolmaster/CoolMaster_Core_Reference_Part5_v1.0.txt §7: "Handle: 200 400 403 404
 * 405 413 500 501. Retry only transient failures."). The 500/501 half of that documented
 * set is treated as transient (a local gateway momentarily overloaded/rebooting); 400/
 * 403/404/405/413 as fatal (a malformed request that retrying won't fix). 502/503/504
 * are NOT in the documented list — added defensively since they're standard codes a
 * local HTTP server can still plausibly return, not inferred from the spec. */
export const REST_TRANSIENT_STATUS_CODES: readonly number[] = [500, 501, 502, 503, 504];
export const REST_FATAL_STATUS_CODES: readonly number[] = [400, 403, 404, 405, 413];
