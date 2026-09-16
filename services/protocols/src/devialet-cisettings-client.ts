/**
 * Devialet CISettings client (§ D4) — the SECOND, secondary protocol layer of the
 * Devialet Fusion Driver. Source of truth: the supplied "API LIST OF COMMANDS"
 * document (Phantom Reactor Custom). Every opcode, parameter shape, and constraint
 * below is taken directly from that document; nothing here is inferred from
 * third-party implementations. CISettings is NEVER a replacement for IP Control R1
 * (`devialet-ip-control-client.ts`) — this client does not import that module, and
 * that module does not import this one. State fusion (which protocol wins for which
 * field) is explicitly D9's job, not this file's.
 *
 * The doc's own opening warning governs this entire client: **"All commands are not
 * available yet."** A documented parameter is not automatically a supported command —
 * see `DEVIALET_CISETTINGS_OPCODES` and `classifyOpcode()`.
 */

// ── Endpoint ─────────────────────────────────────────────────────────────────────
/**
 * CISettings has a FIXED path shape — `http://<IP-Address>/cisettings/<opcode>` — per
 * the doc's own "URL format" section. Unlike `DevialetEndpoint` (R1), there is no
 * discovered/variable path component here: CISettings and R1 are separate protocol
 * surfaces addressed differently, even though they may share the same physical
 * device's `host` as transport information.
 */
export interface DevialetCiSettingsEndpoint {
  host: string;
}

// ── Capability provenance (§10 of the D4 brief) ─────────────────────────────────
/**
 * - `"documented"` — the doc establishes this opcode/operation exists and (per §2's
 *   own list) is NOT one of the explicitly-unavailable commands.
 * - `"probed"` — the driver has actually exercised this opcode against a real device
 *   and observed it work. NOTHING in this client assigns this value automatically
 *   (§11 — no automatic probing in D4); it exists for a future caller (D9+) to record
 *   after a real, observed success.
 * - `"unavailable"` — the doc's §2 explicitly names this command as not yet available
 *   on real firmware. `DevialetCiSettingsClient` structurally refuses to send ANY
 *   request (read or write) for these — see `getRaw()`.
 * - `"unknown"` — not present in `DEVIALET_CISETTINGS_OPCODES` at all (a future/
 *   undocumented opcode). Never treated as "safe to assume works."
 */
export type DevialetCiSettingsProvenance = "documented" | "probed" | "unavailable" | "unknown";

export type DevialetCiSettingsAccess = "read" | "write" | "read-write";

export interface DevialetCiSettingsOpcodeInfo {
  opcode: string;
  access: DevialetCiSettingsAccess;
  provenance: DevialetCiSettingsProvenance;
  /** Per the doc's "Async. Notification?" column — whether the device is documented
   * to push unsolicited updates for this parameter. NO subscription/notification
   * mechanism is implemented anywhere in this client (§15) — this is classification
   * metadata only, for a future integration to consult. */
  asyncNotification: boolean;
  /** Per "List of boot-persistent parameters" — survives a run→standby→run cycle. */
  bootPersistent: boolean;
}

/**
 * Every opcode named anywhere in the supplied documentation, classified per the rules
 * above. The eleven `"unavailable"` entries are copied verbatim from §2's own list —
 * `EQ[n]` (n = 1-4) collapses to one registry entry (`"eq"`) since the doc describes
 * it as one parameter family, not four independently-available opcodes.
 */
export const DEVIALET_CISETTINGS_OPCODES: Record<string, DevialetCiSettingsOpcodeInfo> = {
  apiversion: { opcode: "apiversion", access: "read", provenance: "documented", asyncNotification: false, bootPersistent: true },
  serialnumber: { opcode: "serialnumber", access: "read", provenance: "documented", asyncNotification: false, bootPersistent: true },
  hardwareversion: { opcode: "hardwareversion", access: "read", provenance: "documented", asyncNotification: false, bootPersistent: true },
  softwareversion: { opcode: "softwareversion", access: "read", provenance: "documented", asyncNotification: false, bootPersistent: true },
  friendlyname: { opcode: "friendlyname", access: "read-write", provenance: "documented", asyncNotification: false, bootPersistent: true },
  internalstate: { opcode: "internalstate", access: "read", provenance: "documented", asyncNotification: true, bootPersistent: false },
  temperature: { opcode: "temperature", access: "read", provenance: "documented", asyncNotification: false, bootPersistent: false },
  power: { opcode: "power", access: "write", provenance: "documented", asyncNotification: false, bootPersistent: false },
  powerstate: { opcode: "powerstate", access: "read", provenance: "documented", asyncNotification: true, bootPersistent: false },
  startupsource: { opcode: "startupsource", access: "read-write", provenance: "documented", asyncNotification: false, bootPersistent: true },
  currentsourcestate: { opcode: "currentsourcestate", access: "read", provenance: "documented", asyncNotification: true, bootPersistent: false },
  currentstreamtype: { opcode: "currentstreamtype", access: "read", provenance: "documented", asyncNotification: true, bootPersistent: false },
  source: { opcode: "source", access: "read-write", provenance: "documented", asyncNotification: true, bootPersistent: false },
  analogsensitivity: { opcode: "analogsensitivity", access: "read-write", provenance: "documented", asyncNotification: false, bootPersistent: true },
  ledmode: { opcode: "ledmode", access: "read-write", provenance: "documented", asyncNotification: false, bootPersistent: false },
  splmax: { opcode: "splmax", access: "read-write", provenance: "documented", asyncNotification: false, bootPersistent: true },
  mix: { opcode: "mix", access: "read-write", provenance: "documented", asyncNotification: false, bootPersistent: true },
  mutemode: { opcode: "mutemode", access: "read-write", provenance: "documented", asyncNotification: true, bootPersistent: true },
  volume: { opcode: "volume", access: "read-write", provenance: "documented", asyncNotification: true, bootPersistent: false },
  startupvolume: { opcode: "startupvolume", access: "read-write", provenance: "documented", asyncNotification: false, bootPersistent: true },
  // § "not available yet" (doc §2, verbatim) — structurally refused, never sent.
  basslevel: { opcode: "basslevel", access: "read-write", provenance: "unavailable", asyncNotification: false, bootPersistent: true },
  treblelevel: { opcode: "treblelevel", access: "read-write", provenance: "unavailable", asyncNotification: false, bootPersistent: true },
  tonecontrolmode: { opcode: "tonecontrolmode", access: "read-write", provenance: "unavailable", asyncNotification: false, bootPersistent: true },
  balancelevel: { opcode: "balancelevel", access: "read-write", provenance: "unavailable", asyncNotification: false, bootPersistent: true },
  icmode: { opcode: "icmode", access: "read-write", provenance: "unavailable", asyncNotification: false, bootPersistent: true },
  subsonicmode: { opcode: "subsonicmode", access: "read-write", provenance: "unavailable", asyncNotification: false, bootPersistent: true },
  nightmode: { opcode: "nightmode", access: "read-write", provenance: "unavailable", asyncNotification: false, bootPersistent: true },
  nightlevel: { opcode: "nightlevel", access: "read-write", provenance: "unavailable", asyncNotification: false, bootPersistent: true },
  delay: { opcode: "delay", access: "read-write", provenance: "unavailable", asyncNotification: false, bootPersistent: true },
  eqmode: { opcode: "eqmode", access: "read-write", provenance: "unavailable", asyncNotification: false, bootPersistent: true },
  eq: { opcode: "eq", access: "read-write", provenance: "unavailable", asyncNotification: false, bootPersistent: true },
  // § Macro commands (doc §3) — named, but the doc gives no URL path for either.
  // Classified "documented" (they are NOT on the §2 unavailable list) with the path
  // ambiguity flagged in the D4 report, not silently resolved.
  getall: { opcode: "getall", access: "read", provenance: "documented", asyncNotification: false, bootPersistent: false },
  getlean: { opcode: "getlean", access: "read", provenance: "documented", asyncNotification: false, bootPersistent: false },
};

/** Static classification only — never the result of a runtime probe (see
 * `DevialetCiSettingsProvenance.probed`'s doc). `"unknown"` for anything not in
 * `DEVIALET_CISETTINGS_OPCODES` at all. */
export function classifyOpcode(opcode: string): DevialetCiSettingsProvenance {
  return DEVIALET_CISETTINGS_OPCODES[opcode.toLowerCase()]?.provenance ?? "unknown";
}

// ── Documented value shapes ──────────────────────────────────────────────────────
/** `powerstate` GET values, per the doc's own numeric/string pairing. */
export type DevialetCiSettingsPowerState = "standby" | "starting" | "running" | "stopping";

/** `currentsourcestate` GET values. */
export type DevialetCiSettingsSourceLockState = "Unlocked" | "Locked";

/** `currentstreamtype` GET values. */
export type DevialetCiSettingsStreamType = "PCM" | "NOTPCM";

/** `ledmode` values — 0-3, per the doc's own enumeration (kept as a plain number, not
 * a string union, since the doc itself represents this opcode numerically). */
export type DevialetCiSettingsLedMode = 0 | 1 | 2 | 3;

/** `mix` values — "L"/"R"/"M" per the doc; any other string is documented to mean
 * silence, so it is preserved as a plain `string`, not narrowed to a 3-value union
 * (narrowing would make a real, documented "silence" value unrepresentable). */
export type DevialetCiSettingsMix = string;

/**
 * `getLean()` result — the doc names exactly these four fields ("getLean() will
 * output the following status simultaneously: PowerState, MuteMode, Volume,
 * Source"). Kept typed (not a raw record) because the doc DOES establish this exact,
 * fixed field set — unlike `getAll()`, whose full shape is genuinely open-ended.
 *
 * § Ambiguity (flagged, not invented past) — the doc gives no worked example for
 * `getLean()`'s response envelope. This shape assumes the SAME `{data:{...}}`
 * envelope every single-opcode GET already uses in the doc's own worked example,
 * with each field's own opcode as the key — the only internally-consistent
 * extrapolation available, but unverified against real firmware.
 */
export interface DevialetCiSettingsLeanState {
  powerstate: string;
  mutemode: string;
  volume: number;
  source: string;
}

// ── Errors (§16 of the D4 brief) ─────────────────────────────────────────────────
export type DevialetCiSettingsErrorKind = "transport" | "http" | "malformed" | "unavailable" | "unknown";

export class DevialetCiSettingsError extends Error {
  readonly kind: DevialetCiSettingsErrorKind;
  readonly httpStatus?: number;
  readonly opcode?: string;
  readonly timedOut?: boolean;

  constructor(kind: DevialetCiSettingsErrorKind, message: string, opts: { httpStatus?: number; opcode?: string; timedOut?: boolean } = {}) {
    super(message);
    this.name = "DevialetCiSettingsError";
    this.kind = kind;
    this.httpStatus = opts.httpStatus;
    this.opcode = opts.opcode;
    this.timedOut = opts.timedOut;
  }
}

export interface DevialetCiSettingsClientOptions {
  fetchImpl?: typeof fetch;
  /** Same default (1000ms) and same rationale as `DevialetIpControlClient` — the
   * CISettings doc defines no timeout of its own, so D3's already-established R1
   * convention is reused rather than inventing a second timeout policy (§17). */
  timeoutMs?: number;
}

/**
 * A clean, typed, injectable, transport-independent Devialet CISettings client.
 * Protocol-only — no diagnostics/tracing/coalescing here either (`devialet-driver.ts`
 * wraps every call, exactly as it does for `DevialetIpControlClient`). No automatic
 * retries (§17); every write-capable method sends exactly one request.
 */
export class DevialetCiSettingsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: DevialetCiSettingsClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 1000;
  }

  // ── Read-only diagnostic/identity opcodes ───────────────────────────────────────
  async getApiVersion(endpoint: DevialetCiSettingsEndpoint): Promise<string> {
    return this.getString(endpoint, "apiversion");
  }
  async getSerialNumber(endpoint: DevialetCiSettingsEndpoint): Promise<string> {
    return this.getString(endpoint, "serialnumber");
  }
  async getHardwareVersion(endpoint: DevialetCiSettingsEndpoint): Promise<string> {
    return this.getString(endpoint, "hardwareversion");
  }
  async getSoftwareVersion(endpoint: DevialetCiSettingsEndpoint): Promise<string> {
    return this.getString(endpoint, "softwareversion");
  }
  /** Raw "OK" / "NOK <ERROR_CODE>" string, exactly as documented — this client does
   * not parse or interpret the "NOK" case; that's real Devialet-reported diagnostic
   * data for a later layer to act on, not an HTTP/transport error. */
  async getInternalState(endpoint: DevialetCiSettingsEndpoint): Promise<string> {
    return this.getString(endpoint, "internalstate");
  }
  /** "Prints a selection of internal temperatures for monitoring purpose only" — the
   * doc types this as a UTF-8 string, not a number, so it is returned as one. */
  async getTemperature(endpoint: DevialetCiSettingsEndpoint): Promise<string> {
    return this.getString(endpoint, "temperature");
  }
  async getPowerState(endpoint: DevialetCiSettingsEndpoint): Promise<DevialetCiSettingsPowerState> {
    const raw = await this.getString(endpoint, "powerstate");
    return parsePowerState(raw);
  }
  async getCurrentSourceState(endpoint: DevialetCiSettingsEndpoint): Promise<DevialetCiSettingsSourceLockState> {
    const raw = await this.getString(endpoint, "currentsourcestate");
    if (raw === "Unlocked" || raw === "Locked") return raw;
    throw new DevialetCiSettingsError("malformed", `devialet-cisettings: unrecognized currentsourcestate value "${raw}"`, { opcode: "currentsourcestate" });
  }
  async getCurrentStreamType(endpoint: DevialetCiSettingsEndpoint): Promise<DevialetCiSettingsStreamType> {
    const raw = await this.getString(endpoint, "currentstreamtype");
    if (raw === "PCM" || raw === "NOTPCM") return raw;
    throw new DevialetCiSettingsError("malformed", `devialet-cisettings: unrecognized currentstreamtype value "${raw}"`, { opcode: "currentstreamtype" });
  }

  // ── Documented read/write opcodes (never one of the §2 unavailable commands) ────
  async getFriendlyName(endpoint: DevialetCiSettingsEndpoint): Promise<string> {
    return this.getString(endpoint, "friendlyname");
  }
  async setFriendlyName(endpoint: DevialetCiSettingsEndpoint, name: string): Promise<void> {
    await this.set(endpoint, "friendlyname", { friendlyname: name });
  }

  /** Write-only per the doc ("Write-only parameter") — there is deliberately no
   * `getPower()`; `getPowerState()` is the documented read side of power. */
  async setPower(endpoint: DevialetCiSettingsEndpoint, on: boolean): Promise<void> {
    await this.set(endpoint, "power", { power: on ? "ON" : "OFF" });
  }

  async getStartupSource(endpoint: DevialetCiSettingsEndpoint): Promise<string> {
    return this.getString(endpoint, "startupsource");
  }
  async setStartupSource(endpoint: DevialetCiSettingsEndpoint, sourceName: string): Promise<void> {
    await this.set(endpoint, "startupsource", { startupsource: sourceName });
  }

  /** Raw current source name/token, exactly as CISettings reports it — no
   * normalization to any SupremeOS/R1 source vocabulary (§14, explicitly deferred). */
  async getSource(endpoint: DevialetCiSettingsEndpoint): Promise<string> {
    return this.getString(endpoint, "source");
  }
  async setSource(endpoint: DevialetCiSettingsEndpoint, sourceName: string): Promise<void> {
    await this.set(endpoint, "source", { source: sourceName });
  }
  async sourceNext(endpoint: DevialetCiSettingsEndpoint): Promise<void> {
    await this.set(endpoint, "source", { source: "UP" });
  }
  async sourcePrevious(endpoint: DevialetCiSettingsEndpoint): Promise<void> {
    await this.set(endpoint, "source", { source: "DOWN" });
  }

  async getAnalogSensitivity(endpoint: DevialetCiSettingsEndpoint): Promise<number> {
    return this.getNumber(endpoint, "analogsensitivity");
  }
  /** 0.5-10.0 Vrms, in 0.5 steps per the doc; out-of-range/rounding is the DEVICE's
   * own documented behavior, not re-implemented client-side. */
  async setAnalogSensitivity(endpoint: DevialetCiSettingsEndpoint, volts: number): Promise<void> {
    await this.set(endpoint, "analogsensitivity", { analogsensitivity: volts });
  }

  async getLedMode(endpoint: DevialetCiSettingsEndpoint): Promise<DevialetCiSettingsLedMode> {
    const n = await this.getNumber(endpoint, "ledmode");
    if (n === 0 || n === 1 || n === 2 || n === 3) return n;
    throw new DevialetCiSettingsError("malformed", `devialet-cisettings: unrecognized ledmode value ${n}`, { opcode: "ledmode" });
  }
  async setLedMode(endpoint: DevialetCiSettingsEndpoint, mode: DevialetCiSettingsLedMode): Promise<void> {
    await this.set(endpoint, "ledmode", { ledmode: mode });
  }

  async getSplMax(endpoint: DevialetCiSettingsEndpoint): Promise<number> {
    return this.getNumber(endpoint, "splmax");
  }
  async setSplMax(endpoint: DevialetCiSettingsEndpoint, dbSpl: number): Promise<void> {
    await this.set(endpoint, "splmax", { splmax: dbSpl });
  }

  async getMix(endpoint: DevialetCiSettingsEndpoint): Promise<DevialetCiSettingsMix> {
    return this.getString(endpoint, "mix");
  }
  async setMix(endpoint: DevialetCiSettingsEndpoint, mix: DevialetCiSettingsMix): Promise<void> {
    await this.set(endpoint, "mix", { mix });
  }

  /**
   * § Secondary/legacy volume source (§13) — this is CISettings' OWN volume, entirely
   * separate from R1's system-level volume. `devialet-driver.ts`/D9 decide which one
   * is authoritative for a given field; this client just reports/sets what CISettings
   * itself reports, never silently treated as equivalent to R1's value.
   */
  async getVolume(endpoint: DevialetCiSettingsEndpoint): Promise<number> {
    return this.getNumber(endpoint, "volume");
  }
  async setVolume(endpoint: DevialetCiSettingsEndpoint, value: number): Promise<void> {
    await this.set(endpoint, "volume", { volume: value });
  }
  async volumeUp(endpoint: DevialetCiSettingsEndpoint): Promise<void> {
    await this.set(endpoint, "volume", { volume: "UP" });
  }
  async volumeDown(endpoint: DevialetCiSettingsEndpoint): Promise<void> {
    await this.set(endpoint, "volume", { volume: "DOWN" });
  }

  async getStartupVolume(endpoint: DevialetCiSettingsEndpoint): Promise<number> {
    return this.getNumber(endpoint, "startupvolume");
  }
  async setStartupVolume(endpoint: DevialetCiSettingsEndpoint, value: number): Promise<void> {
    await this.set(endpoint, "startupvolume", { startupvolume: value });
  }

  /**
   * § Important power semantics (§12) — this is CISettings' own `mutemode`, a
   * DIFFERENT concept/field from R1's `muteState` (`/groups/.../sources/current`).
   * Parsed leniently (`"ON"`/`"OFF"`/1/0/boolean) because the doc shows only the
   * WRITE-side value grammar, not a worked GET response example — flagged in the D4
   * report, not silently assumed.
   */
  async getMuteMode(endpoint: DevialetCiSettingsEndpoint): Promise<boolean> {
    const raw = await this.getRaw<unknown>(endpoint, "mutemode");
    return parseOnOff(raw, "mutemode");
  }
  async setMuteMode(endpoint: DevialetCiSettingsEndpoint, on: boolean): Promise<void> {
    await this.set(endpoint, "mutemode", { mutemode: on ? "ON" : "OFF" });
  }

  // ── Macro commands (§3 of the doc; §6/§7 of the D4 brief) ───────────────────────
  /**
   * `getAll()` — "will output all status simultaneously." The full opcode surface is
   * genuinely open-ended (every current/future opcode), so — per the D4 brief's own
   * guidance — this is intentionally left as a raw record at the protocol boundary
   * rather than a fabricated exhaustive interface. § Ambiguity: the doc gives no URL
   * for this macro; `getall` is used here as the opcode itself, following the exact
   * same `/cisettings/<opcode>` pattern every other command already uses — a
   * reasonable, doc-consistent inference, not a new invented mechanism, but
   * UNVERIFIED against real firmware (see D4 report).
   */
  async getAll(endpoint: DevialetCiSettingsEndpoint): Promise<Record<string, unknown>> {
    return this.getRaw<Record<string, unknown>>(endpoint, "getall");
  }

  /**
   * `getLean()` — "will output the following status simultaneously: PowerState,
   * MuteMode, Volume, Source." Same URL-path ambiguity as `getAll()` (see above);
   * additionally, the exact JSON key casing for the 4 fields is unverified — this
   * uses the opcodes' own lowercase wire names (`powerstate`/`mutemode`/`volume`/
   * `source`), consistent with every other opcode's response key in the doc's
   * worked example.
   */
  async getLean(endpoint: DevialetCiSettingsEndpoint): Promise<DevialetCiSettingsLeanState> {
    const raw = await this.getRaw<Record<string, unknown>>(endpoint, "getlean");
    const powerstate = raw.powerstate;
    const mutemode = raw.mutemode;
    const volume = raw.volume;
    const source = raw.source;
    if (typeof powerstate !== "string" || typeof mutemode !== "string" || typeof volume !== "number" || typeof source !== "string") {
      throw new DevialetCiSettingsError("malformed", `devialet-cisettings: getLean() response did not match the documented {powerstate,mutemode,volume,source} shape`, { opcode: "getlean" });
    }
    return { powerstate, mutemode, volume, source };
  }

  // ── Low-level escape hatch (safe reads only) ────────────────────────────────────
  /**
   * A generic, read-only escape hatch for an opcode with no dedicated typed method
   * yet. Structurally REFUSES to send any request — not even a GET — for an opcode
   * `classifyOpcode()` marks `"unavailable"` (§9/§11: "Do not silently send them to a
   * device," applied conservatively to reads as well as writes here). Does NOT
   * refuse `"unknown"` opcodes (a GET is non-mutating and may be exactly how a future
   * caller safely determines real support — see `DevialetCiSettingsProvenance`'s
   * doc), but never blindly assumes success means "supported for every device."
   */
  async getRaw<T>(endpoint: DevialetCiSettingsEndpoint, opcode: string): Promise<T> {
    if (classifyOpcode(opcode) === "unavailable") {
      throw new DevialetCiSettingsError("unavailable", `devialet-cisettings: "${opcode}" is documented as not yet available — refusing to send a request`, { opcode });
    }
    return this.request<T>(endpoint, "GET", opcode);
  }

  private async getString(endpoint: DevialetCiSettingsEndpoint, opcode: string): Promise<string> {
    const value = await this.getRaw<unknown>(endpoint, opcode);
    if (typeof value !== "string") {
      throw new DevialetCiSettingsError("malformed", `devialet-cisettings: expected a string for "${opcode}", got ${typeof value}`, { opcode });
    }
    return value;
  }

  private async getNumber(endpoint: DevialetCiSettingsEndpoint, opcode: string): Promise<number> {
    const value = await this.getRaw<unknown>(endpoint, opcode);
    if (typeof value !== "number") {
      throw new DevialetCiSettingsError("malformed", `devialet-cisettings: expected a number for "${opcode}", got ${typeof value}`, { opcode });
    }
    return value;
  }

  /** Every write goes through here — refuses `"unavailable"` opcodes exactly like
   * `getRaw()`, and additionally refuses any opcode this client has no explicit
   * typed setter calling it for (this method is private; every caller is one of the
   * named methods above, each sending exactly the JSON body shape that specific
   * opcode documents — never a generic passthrough body). */
  private async set(endpoint: DevialetCiSettingsEndpoint, opcode: string, body: Record<string, unknown>): Promise<void> {
    if (classifyOpcode(opcode) === "unavailable") {
      throw new DevialetCiSettingsError("unavailable", `devialet-cisettings: "${opcode}" is documented as not yet available — refusing to send a request`, { opcode });
    }
    await this.request<Record<string, never>>(endpoint, "POST", opcode, body);
  }

  // ── Core request/response/error handling ────────────────────────────────────────
  private baseUrl(endpoint: DevialetCiSettingsEndpoint): string {
    const host = endpoint.host.startsWith("http") ? endpoint.host.replace(/\/$/, "") : `http://${endpoint.host}`;
    return `${host}/cisettings`;
  }

  private async request<T>(endpoint: DevialetCiSettingsEndpoint, method: "GET" | "POST", opcode: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl(endpoint)}/${opcode}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: method === "POST" ? { "content-type": "application/json" } : undefined,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new DevialetCiSettingsError("transport", `devialet-cisettings: request to ${opcode} timed out after ${this.timeoutMs}ms`, { opcode, timedOut: true });
      }
      throw new DevialetCiSettingsError("transport", `devialet-cisettings: network failure calling ${opcode} — ${err instanceof Error ? err.message : String(err)}`, { opcode });
    }
    clearTimeout(timer);

    if (!res.ok) {
      // § Ambiguity — the doc defines NO error response shape at all (unlike R1's
      // documented {error:{code,...}}). An HTTP failure status is therefore the only
      // reliable signal available; the body (if any) is not parsed or trusted.
      throw new DevialetCiSettingsError("http", `devialet-cisettings: HTTP ${res.status} calling ${opcode}`, { httpStatus: res.status, opcode });
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new DevialetCiSettingsError("malformed", `devialet-cisettings: malformed JSON response from ${opcode}`, { opcode });
    }

    if (method === "POST") return parsed as T;

    // § GET response envelope — every worked example in the doc wraps the value as
    // {"data": {"<opcode>": value}}. A response missing this shape is malformed, not
    // a value of `undefined`.
    if (typeof parsed !== "object" || parsed === null || !("data" in parsed)) {
      throw new DevialetCiSettingsError("malformed", `devialet-cisettings: response from ${opcode} is missing the documented "data" envelope`, { opcode });
    }
    const data = (parsed as { data: unknown }).data;
    if (typeof data !== "object" || data === null) {
      throw new DevialetCiSettingsError("malformed", `devialet-cisettings: response "data" from ${opcode} is not an object`, { opcode });
    }
    if (opcode === "getall" || opcode === "getlean") return data as T;
    if (!(opcode in data)) {
      throw new DevialetCiSettingsError("malformed", `devialet-cisettings: response "data" from ${opcode} is missing the "${opcode}" key`, { opcode });
    }
    return (data as Record<string, unknown>)[opcode] as T;
  }
}

// ── Pure parsers (no HTTP concerns) ──────────────────────────────────────────────
function parsePowerState(raw: string): DevialetCiSettingsPowerState {
  if (raw === "standby" || raw === "starting" || raw === "running" || raw === "stopping") return raw;
  throw new DevialetCiSettingsError("malformed", `devialet-cisettings: unrecognized powerstate value "${raw}"`, { opcode: "powerstate" });
}

/** Lenient on/off parser — see `getMuteMode()`'s doc for why this exists instead of
 * a strict string check. Never a generic "truthy" coercion: only the exact
 * documented write-side tokens (plus a real boolean, for defensiveness) are
 * accepted. */
function parseOnOff(raw: unknown, opcode: string): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") {
    if (raw === 0) return false;
    if (raw === 1) return true;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toUpperCase();
    if (normalized === "ON") return true;
    if (normalized === "OFF") return false;
  }
  throw new DevialetCiSettingsError("malformed", `devialet-cisettings: unrecognized on/off value for "${opcode}": ${JSON.stringify(raw)}`, { opcode });
}
