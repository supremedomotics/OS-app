/**
 * CoolMaster (CoolAutomation CoolMasterNet/CoolLinux gateway) driver — shared types.
 *
 * Source of truth: docs/coolmaster/ (the CoolMaster protocol reference set) plus the
 * ASCII_IF wire behaviour already validated by this codebase's prior driver (ls2 line
 * shape, on/off/temp/mode command grammar). Where the reference docs describe a command
 * by name only, without exact syntax/response fields (wh, main, vam, group, va — see
 * each doc's own "NOTE: populate from the official PRM" markers), this driver still
 * implements a best-effort version using the ASCII_IF grammar the REST of the protocol
 * consistently follows (verb + UID + optional args), and flags that inference at the
 * call site and in docs/coolmaster/CoolMaster_SupremeOS_Implementation_Guide_v1.0.txt's
 * companion README — never silently presented as confirmed-against-spec.
 */

// ── Connection ────────────────────────────────────────────────────────────────────

/** Which wire protocol a request actually went over. */
export type CoolMasterTransportKind = "ascii" | "rest";

/** How the driver picks a transport. "auto" prefers REST (native JSON, no line-protocol
 * parsing) and falls back to ASCII_IF when REST is unreachable (older gateway firmware,
 * REST disabled, or transient REST-only failure) — per the reference docs' "REST should
 * be preferred... ASCII_IF should be used where required by the protocol" guidance. */
export type CoolMasterProtocolMode = "auto" | "ascii" | "rest";

export type CoolMasterConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

// ── UID addressing ──────────────────────────────────────────────────────────────────

/** Opaque CoolMaster address, e.g. "L1.100" (indoor unit on HVAC line 1, address 100),
 * "W1.001" (water heater), "M1" (main controller). Deliberately not a single strict enum
 * regex: the PRM documents THREE UID modes (plain/"UID Strict"/"4-Digit UID") selected by
 * the installer via `set`, and this driver must tolerate whichever one is configured
 * rather than assume one — see docs/coolmaster/CoolMaster_Core_Reference_v1.0.txt §6. */
export type CoolMasterUid = string;

export type CoolMasterDeviceKind = "indoor_unit" | "water_heater" | "main_controller" | "ventilation" | "group";

// ── HVAC operating vocabulary ────────────────────────────────────────────────────────

/** The five ASCII_IF mode command words (each IS the command sent, e.g. "cool L1.100"). */
export type CoolMasterModeWord = "cool" | "heat" | "auto" | "dry" | "fan";

/** Fan speed words as commonly exposed by ASCII_IF `fspeed`. Not every line/brand
 * supports every value (some units lack "Top"/have only 3 speeds) — a unit's actual
 * supported set is discovered, never assumed; see ClimateCapabilityConfig.fanSpeeds. */
export type CoolMasterFanSpeed = "Auto" | "Low" | "Med" | "High" | "Top";

/** Swing values are genuinely brand-variant on real hardware (some units expose
 * Auto/Swing/Pos1-5, others just On/Off) — never validated against a fixed enum, always
 * passed through from what discovery/config reports. */
export type CoolMasterSwingValue = string;

export interface CoolMasterUnitStatus {
  uid: CoolMasterUid;
  /** HVAC line this unit belongs to, e.g. "L1" — parsed from the UID's line segment. */
  line: string;
  on: boolean;
  /** Target/setpoint temperature in °C (converted from °F if the gateway reports °F —
   * see set.temperatureUnits). Null when the unit hasn't reported one yet. */
  setpointC: number | null;
  /** Ambient/room temperature in °C, as measured by the indoor unit's own sensor. */
  roomC: number | null;
  mode: CoolMasterModeWord | null;
  fanSpeed: CoolMasterFanSpeed | string | null;
  swing: CoolMasterSwingValue | null;
  /** true when the filter-clean warning is active (`filt` command / ls2 filter field). */
  filterWarning: boolean | null;
  /** true while the compressor/unit is actively calling for cool/heat (demand), as
   * distinct from `on` (powered) — some units report this, many don't. */
  demand: boolean | null;
  /** Raw fault/error code as reported by ls2/query; null = no fault. The exact code
   * table is manufacturer-specific and NOT decoded into a fixed enum here (the PRM does
   * not publish one universal table) — surfaced verbatim so installers can look it up
   * against their unit's own service manual. */
  faultCode: string | null;
  /** True when this unit's remote-controller lock is engaged (`lock` command). */
  locked: boolean | null;
  /** True when installer inhibit is engaged (`inhibit` command) — user operation blocked
   * regardless of lock state. */
  inhibited: boolean | null;
  /** Exit/status code from the line this unit was parsed from ("OK" or an error token). */
  exitCode: string;
  /** Which transport this reading came from, for diagnostics. */
  source: CoolMasterTransportKind;
}

// ── Gateway / line / group / secondary device metadata ──────────────────────────────

export interface CoolMasterGatewayInfo {
  serial: string;
  firmwareVersion: string;
  /** Free-form application/model string ("CoolMasterNet", "CoolLinux", …) when reported. */
  application: string | null;
  host: string;
}

export interface CoolMasterLineInfo {
  /** Line identifier, e.g. "L1". */
  id: string;
  /** Manufacturer/protocol this line is configured for when the gateway reports it
   * (e.g. "Daikin", "Mitsubishi", "Toshiba") — installer-configured, not always exposed. */
  manufacturer: string | null;
  active: boolean;
}

export interface CoolMasterGroupInfo {
  id: string;
  label: string;
  memberUids: CoolMasterUid[];
}

export interface CoolMasterWaterHeaterStatus {
  uid: CoolMasterUid;
  on: boolean;
  setpointC: number | null;
  roomC: number | null;
  faultCode: string | null;
}

export interface CoolMasterVentilationStatus {
  uid: CoolMasterUid;
  on: boolean;
  fanSpeed: CoolMasterFanSpeed | string | null;
  faultCode: string | null;
}

export interface CoolMasterMainControllerStatus {
  uid: CoolMasterUid;
  on: boolean;
  faultCode: string | null;
}

/** Everything a full discovery pass produces — consumed by coolmaster-mapper.ts to
 * build DiscoveredDevice[] and by coolmaster-cache.ts to seed initial state. */
export interface CoolMasterDiscoveryResult {
  gateway: CoolMasterGatewayInfo;
  lines: CoolMasterLineInfo[];
  units: CoolMasterUnitStatus[];
  groups: CoolMasterGroupInfo[];
  waterHeaters: CoolMasterWaterHeaterStatus[];
  ventilation: CoolMasterVentilationStatus[];
  mainControllers: CoolMasterMainControllerStatus[];
}

// ── Configuration ─────────────────────────────────────────────────────────────────

export interface CoolMasterDriverConfig {
  /** Gateway IP/hostname on the local network. Required. */
  host: string;
  /** Which transport to use. Default "auto" (prefer REST, fall back to ASCII_IF). */
  protocol?: CoolMasterProtocolMode;
  /** ASCII_IF TCP port. CoolMasterNet default 10102. */
  asciiPort?: number;
  /** Local REST API port. Per docs/coolmaster/CoolMaster_Core_Reference_Part5_v1.0.txt
   * §1, default 10103. */
  restPort?: number;
  /** Fast poll period (HVAC state/temperature/faults) in ms. Default 10000. */
  pollMs?: number;
  /** Slow poll period (configuration/line info, rarely changes) in ms. Default 300000. */
  slowPollMs?: number;
  /** Re-run full discovery on this interval in ms in addition to on reconnect/manual
   * request, so units added at the gateway later are picked up. Default 1800000 (30m). */
  discoveryIntervalMs?: number;
  /** Per-request timeout in ms, both transports. Default 5000. */
  timeoutMs?: number;
  /** Max command retry attempts on a transient failure. Default 3. */
  retryCount?: number;
  /** Base backoff delay in ms for reconnect/retry exponential backoff. Default 1000. */
  backoffBaseMs?: number;
  /** Max backoff delay in ms. Default 60000. */
  backoffMaxMs?: number;
  debug?: boolean;
  /** Injectable transports — tests point these at in-process fakes instead of real I/O. */
  createSocket?: (host: string, port: number) => import("node:net").Socket;
  fetchImpl?: typeof fetch;
}

/** Fully-defaulted config after validation — see coolmaster-constants.ts DEFAULT_CONFIG. */
export type ResolvedCoolMasterConfig = Required<
  Omit<CoolMasterDriverConfig, "createSocket" | "fetchImpl">
> &
  Pick<CoolMasterDriverConfig, "createSocket" | "fetchImpl">;
