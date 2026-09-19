import type { CapabilityCommand, CapabilityState, HvacStatus } from "@supreme/domain-model";

/**
 * KNX capability ↔ datapoint-value codec (§3, §7). KNX devices are addressed by
 * **group address** (e.g. "1/1/3") and typed by **DPT** (datapoint type). This maps
 * Supreme capabilities to the decoded JS values KNXnet/IP carries:
 *
 *   onoff      → DPT1.001    boolean
 *   brightness → DPT5.001    scaling 0..100 (%)          (on/off derived from level)
 *   position   → DPT5.001    scaling 0..100 (% open)
 *   sensor     → DPT9.001    2-byte float (e.g. °C)      (read-only)
 *   color      → DPT232.600  RGB triplet {red,green,blue} 0..255 each
 *              → DPT251.600  RGBW {red,green,blue,white,mR,mG,mB,mW} — white channel is
 *                left unset (mW: 0) since Supreme's ColorState has no dedicated white
 *                channel; only RGB is driven.
 *              → DPT7.600    absolute colour temperature in Kelvin (tunable-white
 *                fixtures with a dedicated colour-temp GA and a separate DPT5.001
 *                brightness GA bound as the device's "brightness" capability)
 *   lock       → DPT1.xxx    boolean (1 = locked, matching the common KNX door-lock
 *                actuator convention)
 *   temperature → DPT9.001   2-byte float °C, single-GA. Real KNX thermostats split
 *                setpoint/ambient/mode/fan/swing across separate group addresses that
 *                Supreme's one-capability-one-binding model can't fuse into one telegram;
 *                the KNX import engine binds the single writable setpoint GA when one is
 *                identifiable (see services/commissioning/src/knx/entity-generator.ts) and
 *                reports the rest as unbound in an import warning rather than fabricating
 *                a fused multi-address state. Reads on the bound GA are reflected as BOTH
 *                `ambientC` and `targetC` (the only real number available) — not a true
 *                ambient/setpoint split.
 *
 * Byte-level DPT (de)serialization is handled by the KNXnet/IP transport; this codec
 * works in decoded values so the driver stays transport-agnostic and unit-testable.
 *
 * § Phase 3.3C-1 — KNX DPT 20.102 (DPT_HVACMode) is the first real HVAC auxiliary-role
 * codec, layered on top of the Phase 3.3B `hvacRoles` architecture rather than the
 * capability-level table above: it decodes/encodes the `operatingMode` semantic role's
 * OWN group address, independent of (and never overwriting) the primary temperature
 * GA's `ambientC`/`targetC`/`mode` fields. See `decodeHvacOperatingMode`/
 * `encodeHvacOperatingMode` below.
 */

export interface KnxRgb {
  red: number;
  green: number;
  blue: number;
}
export interface KnxRgbw extends KnxRgb {
  white: number;
  mR: number;
  mG: number;
  mB: number;
  mW: number;
}
/** § Phase 3.3C-5B — the compound 3-field payload DPT 222.100 (`DPT_TempRoomSetpSetF16[3]`)
 * carries in ONE Group Object (6 octets: three 2-byte KNX floats). Field names match the
 * real `knxultimate` DPT222 handler's own decoded shape (`{Comfort, Standby, Economy}`,
 * lowercased to this codebase's convention) — this driver's only real transport for this
 * DPT, so this type is defined to be exactly what that transport actually hands back, not
 * an independently-invented shape. */
export interface KnxSetpoints {
  comfort: number;
  standby: number;
  economy: number;
}
export type KnxValue = boolean | number | KnxRgb | KnxRgbw | KnxSetpoints;

/** Default DPT for a capability when a binding doesn't specify one. */
export function defaultDpt(capability: CapabilityState["kind"]): string {
  switch (capability) {
    case "onoff":
      return "DPT1.001";
    case "brightness":
    case "position":
      return "DPT5.001";
    case "sensor":
      return "DPT9.001";
    case "color":
      return "DPT232.600";
    case "lock":
      return "DPT1.001";
    case "temperature":
      return "DPT9.001";
    default:
      return "DPT1.001";
  }
}

/** Translate a Supreme command into the KNX group-write value (null = unsupported). */
export function valueFromCommand(
  command: CapabilityCommand,
  prev: CapabilityState | null,
  dpt?: string,
): KnxValue | null {
  switch (command.capability) {
    case "onoff": {
      if (command.action === "toggle") return !(prev?.kind === "onoff" ? prev.on : false);
      return command.action === "on";
    }
    case "brightness": {
      if (command.action === "off") return 0;
      if (typeof command.level === "number") return clampPct(command.level);
      // "on" with no level → full brightness on a scaling object.
      return prev?.kind === "brightness" && prev.level > 0 ? prev.level : 100;
    }
    case "position": {
      if (command.action === "open") return 100;
      if (command.action === "close") return 0;
      if (typeof command.position === "number") return clampPct(command.position);
      return prev?.kind === "position" ? prev.position : 0;
    }
    case "color": {
      const { major } = dptParts(dpt);
      if (major === 7) {
        // Colour-temperature-only DPT (tunable white): plain Kelvin passthrough.
        if (typeof command.kelvin === "number") return clampKelvin(command.kelvin);
        return prev?.kind === "color" && prev.kelvin !== null ? prev.kelvin : 4000;
      }
      const prevColor = prev?.kind === "color" ? prev : null;
      const hue = command.hue ?? prevColor?.hue ?? 0;
      const saturation = command.saturation ?? prevColor?.saturation ?? 100;
      const level = command.level ?? prevColor?.level ?? 100;
      const { red, green, blue } = hsvToRgb(hue, saturation, level);
      if (major === 251) return { red, green, blue, white: 0, mR: 1, mG: 1, mB: 1, mW: 0 };
      return { red, green, blue };
    }
    case "lock":
      return command.action === "lock";
    case "temperature":
      if (typeof command.targetC === "number") return command.targetC;
      return prev?.kind === "temperature" ? prev.targetC ?? prev.ambientC : 21;
    default:
      return null; // media not mapped to a KNX DPT
  }
}

/** Translate a decoded KNX group value into a Supreme capability state (null = ignore).
 * `sibling` — the SAME device's own `onoff`/`brightness` capability's last known
 * `{on, level}` — is ONLY consulted for the DPT7.600 (Kelvin-only) `color` case below; every
 * other branch is unaffected. */
export function stateFromValue(
  capability: CapabilityState["kind"],
  value: KnxValue,
  config: Record<string, unknown> = {},
  sibling?: { on: boolean; level: number } | null,
): CapabilityState | null {
  switch (capability) {
    case "onoff":
      return { kind: "onoff", on: toBool(value) };
    case "brightness": {
      const level = clampPct(Number(value));
      return { kind: "brightness", on: level > 0, level };
    }
    case "position":
      return { kind: "position", position: clampPct(Number(value)), moving: false };
    case "color": {
      if (typeof value === "number") {
        // § live-confirmed fix (Matter Bridge Phase 1.3) — DPT7.600 (colour-temperature-only,
        // "tunable white") carries ONLY a Kelvin value; it has no on/off or brightness signal
        // at all. This used to hardcode `on:true, level:100` regardless of the device's REAL
        // state — a genuine fabrication, and the exact root cause of "Apple Home On/Off doesn't
        // work" for a KNX CCT light with separately-bound onoff/brightness/color capabilities
        // (confirmed live against a real gateway, `dev_01M20KNF46BZ9ECFD40KVXM8G2` "Conference
        // Hanging"): every CCT update reported this device as `on:true` via its `color`
        // capability regardless of the ACTUAL onoff/brightness state, and the Matter Bridge
        // seeds/refreshes its OnOff attribute from a Color Temperature Light's `color`
        // capability (its `primaryCapability`) — so a real "off" on the onoff/brightness
        // capability was permanently masked by this fabricated `on:true`. `sibling` — this same
        // device's own onoff/brightness capability's last known `{on, level}`, the ACTUAL
        // source of truth for a KNX light's on/off + level (see `SupremeKnxDriver.observe()`'s
        // call site) — is used when available; falls back to the old hardcoded values only when
        // genuinely nothing else is known yet (a device with no onoff/brightness binding at
        // all), never worse than before.
        return { kind: "color", on: sibling?.on ?? true, level: sibling?.level ?? 100, hue: null, saturation: null, kelvin: clampKelvin(value) };
      }
      if (typeof value === "object" && value !== null && "red" in value) {
        const { hue, saturation, level } = rgbToHsv(value.red, value.green, value.blue);
        return { kind: "color", on: level > 0, level, hue, saturation, kelvin: null };
      }
      return null;
    }
    case "sensor":
      return {
        kind: "sensor",
        value: Number(value),
        unit: typeof config.unit === "string" ? config.unit : "",
        measure: typeof config.measure === "string" ? config.measure : "value",
      };
    case "lock":
      return { kind: "lock", locked: toBool(value), jammed: false };
    case "temperature": {
      // Single-GA fidelity (see the module docstring): the one real number we have is
      // reflected as both fields rather than fabricating a separate ambient reading.
      const v = Number(value);
      return { kind: "temperature", ambientC: v, targetC: v, mode: "auto" };
    }
    default:
      return null;
  }
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
function clampKelvin(n: number): number {
  return Math.max(1000, Math.min(10000, Math.round(n)));
}
function toBool(v: KnxValue): boolean {
  return typeof v === "boolean" ? v : v !== 0;
}

/** Parse "DPT232.600" / "232.600" / "232" → { major, minor }. */
export function dptParts(dpt: string | undefined): { major: number; minor: number | null } {
  const m = dpt ? /(\d+)(?:\.(\d+))?/.exec(dpt) : null;
  if (!m) return { major: 232, minor: null }; // default: full-colour RGB
  return { major: Number(m[1]), minor: m[2] ? Number(m[2]) : null };
}

/** The five real values `TemperatureState.operatingMode` can hold — see
 * `packages/domain-model/src/capabilities.ts`'s own field (§ HVAC Domain-Model
 * Correction, Phase 3.3A). Re-derived here rather than duplicated by hand, so this codec
 * can never drift out of sync with the universal schema. */
type HvacOperatingMode = NonNullable<Extract<CapabilityState, { kind: "temperature" }>["operatingMode"]>;

/**
 * § Phase 3.3C-1 — KNX DPT 20.102 (`DPT_HVACMode`), verified against the canonical KNX
 * Association "KNX Standard Interworking Datapoint Types" v02.02.01 §4.3: format N8 (1
 * octet, unsigned enum, PDT_ENUM8), values `0=Auto, 1=Comfort, 2=Standby, 3=Economy,
 * 4=Building Protection, 5...255=reserved`. The document explicitly designates this DPT
 * as the one used "to set the HVAC Mode" (a command/write concept) — status/diagnostic
 * reporting of the current mode is a SEPARATE DPT (`DPT_StatusRHCC`, 22.101, not
 * implemented — § Phase 3.3C-1 non-goals) that this codec does not touch.
 */
const HVAC_OPERATING_MODE_FROM_KNX: Record<number, HvacOperatingMode> = {
  0: "auto",
  1: "comfort",
  2: "standby",
  3: "economy",
  4: "building_protection",
};
const HVAC_OPERATING_MODE_TO_KNX: Record<HvacOperatingMode, number> = {
  auto: 0,
  comfort: 1,
  standby: 2,
  economy: 3,
  building_protection: 4,
};

/** Decodes a raw KNX DPT 20.102 value into `TemperatureState.operatingMode`. Values 5-255
 * are reserved per the canonical document and MUST NOT be silently mapped to a valid
 * mode (§ "never fabricate KNX semantics") — returns `null` for any value outside 0-4,
 * including non-integers and negative numbers; the caller must treat `null` as "ignore
 * this telegram," never as a fallback to "auto" or any other specific mode. */
export function decodeHvacOperatingMode(value: KnxValue): HvacOperatingMode | null {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return HVAC_OPERATING_MODE_FROM_KNX[n] ?? null;
}

/** Encodes `TemperatureState`/command `operatingMode` into the raw DPT 20.102 value to
 * write. The universal command schema's `operatingMode` field is already constrained to
 * these five values by its own zod enum (`packages/domain-model/src/capabilities.ts`), so
 * this is a total function — every legal input has a defined encoding. */
export function encodeHvacOperatingMode(mode: HvacOperatingMode): number {
  return HVAC_OPERATING_MODE_TO_KNX[mode];
}

/**
 * § Phase 3.3C-2 — KNX DPT 20.105 (`DPT_HVACContrMode`), verified against the canonical
 * KNX Association "KNX Standard Interworking Datapoint Types" v02.02.01 §4.3: format N8
 * (1 octet, unsigned enum, PDT_ENUM8), range `{[0...17], 20}` valid, `18-19` and `21-255`
 * reserved. A DIFFERENT concept from DPT 20.102 (§ Phase 3.3C-1) — this is the plant/
 * controller's real OPERATING mode (what it is actually doing right now: heating,
 * morning-warmup, emergency steam, etc.), not a comfort/energy preset. This DPT has no
 * documented write-side "set the controlling mode" role in the canonical material
 * reviewed (unlike 20.102, which the document explicitly designates for writing) — it is
 * intentionally READ/FEEDBACK-ONLY in this driver (§8 of the Phase 3.3C-2 spec): there is
 * no `encodeHvacControllingMode` function, and `TemperatureState`'s command schema (frozen,
 * Phase 3.3A) has no `controllingModeExtended` command field for this codec to serve even
 * if one were added.
 *
 * String tokens match `packages/domain-model/src/capabilities.ts`'s own
 * `controllingModeExtended` doc comment verbatim (chosen there, reused here — never a
 * second, independently-invented vocabulary) — snake_case, protocol-neutral (no "knx_"
 * prefix, no raw DPT terminology), one token per canonical value.
 */
const HVAC_CONTROLLING_MODE_FROM_KNX: Record<number, string> = {
  0: "auto",
  1: "heat",
  2: "morning_warmup",
  3: "cool",
  4: "night_purge",
  5: "precool",
  6: "off",
  7: "test",
  8: "emergency_heat",
  9: "fan_only",
  10: "free_cool",
  11: "ice",
  12: "maximum_heating",
  13: "economic_heat_cool",
  14: "dehumidification",
  15: "calibration",
  16: "emergency_cool",
  17: "emergency_steam",
  20: "no_demand",
};

/** Decodes a raw KNX DPT 20.105 value into `TemperatureState.controllingModeExtended`.
 * `18`, `19`, and `21-255` are reserved per the canonical document and MUST NOT be
 * silently mapped to a valid value (§ "never fabricate KNX semantics") — returns `null`
 * for any value outside the valid set, including non-integers and negative numbers; the
 * caller must treat `null` as "ignore this telegram," never as a fallback to `"auto"` or
 * any other specific value. */
export function decodeHvacControllingMode(value: KnxValue): string | null {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return HVAC_CONTROLLING_MODE_FROM_KNX[n] ?? null;
}

/** `TemperatureState.heatCool`'s only two real values — re-derived from the universal
 * schema (§ Phase 3.3A), never duplicated by hand. */
type HvacHeatCool = NonNullable<Extract<CapabilityState, { kind: "temperature" }>["heatCool"]>;

/**
 * § Phase 3.3C-3 — KNX DPT 1.100 (`DPT_Heat/Cool`), verified against the canonical KNX
 * Association "KNX Standard Interworking Datapoint Types" v02.02.01 §3.1 (Datapoint Types
 * table, format B1): a single bit, `0 = cooling`, `1 = heating`. This is a plain 1-byte
 * KNX Standard Group-Object DPT — no Z8 status/command field — so it round-trips through
 * this driver's existing single-value `observe()`/`write()` GA abstraction exactly like
 * DPT 1.001/1.008/etc. already do.
 *
 * DPT 200.100 (`DPT_Heat/Cool_Z`) is the SAME underlying bit plus a Z8 STATUS/COMMAND
 * byte (§4.1 of the canonical document): that Z8 field is explicitly documented as
 * requiring the LTE-specific `A_GroupPropertyValue_*` Application Layer services to
 * disambiguate a Read/Response/InfoReport (STATUS interpretation) from a Write (COMMAND
 * interpretation) — the document's own Constraint states this Z8 interpretation "is not
 * applicable to... standard Group Objects" because `A_GroupValue_Write` (what this
 * driver's `KnxConnection.write`/`observe` actually send/receive) "does not
 * differentiate between InfoReport and Write service," making that interpretation
 * "ambiguous." This driver has no LTE property-service transport — only plain
 * `A_GroupValue_Write`/`A_GroupValue_Read` group-address telegrams — so DPT 200.100
 * cannot be safely decoded/encoded without either fabricating a Z8 interpretation this
 * driver cannot actually distinguish, or silently discarding real status information.
 * Per Phase 3.3C-3 §6, this is reported rather than forced: DPT 200.100 is NOT
 * implemented this phase; only the plain DPT 1.100 bit is.
 */
const HVAC_HEAT_COOL_FROM_KNX: Record<number, HvacHeatCool> = {
  0: "cool",
  1: "heat",
};
const HVAC_HEAT_COOL_TO_KNX: Record<HvacHeatCool, number> = {
  cool: 0,
  heat: 1,
};

/** Decodes a raw KNX DPT 1.100 value into `TemperatureState.heatCool`. Any value other
 * than the boolean/0/1 forms (§ "never fabricate KNX semantics") returns `null` — the
 * caller must treat `null` as "ignore this telegram," never as a fallback to `"heat"` or
 * `"cool"`. */
export function decodeHeatCool(value: KnxValue): HvacHeatCool | null {
  if (typeof value === "boolean") return value ? "heat" : "cool";
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return HVAC_HEAT_COOL_FROM_KNX[n] ?? null;
}

/** Encodes `TemperatureState`/command `heatCool` into the raw DPT 1.100 value to write.
 * The universal command schema's `heatCool` field is already constrained to these two
 * values by its own zod enum, so this is a total function. */
export function encodeHeatCool(mode: HvacHeatCool): number {
  return HVAC_HEAT_COOL_TO_KNX[mode];
}

/**
 * § Phase 3.3C-4 — KNX DPT 22.101 (`DPT_StatusRHCC`), verified against the canonical KNX
 * Association "KNX Standard Interworking Datapoint Types" v02.02.01 §4.5.2: format B16 (2
 * octets, 16 independent bits, PDT_BITSET16), bit 0 = LSB. Bit-exact layout from the
 * canonical document's Data Fields table:
 *
 *   bit 0  Fault                (M) 0=false 1=true
 *   bit 1  StatusEcoH           (O) 0=false 1=true
 *   bit 2  TempFlowLimit        (O) 0=false 1=true
 *   bit 3  TempReturnLimit      (O) 0=false 1=true
 *   bit 4  StatusMorningBoostH  (O) 0=false 1=true  — NOT represented, see below
 *   bit 5  StatusStartOptim     (O) 0=false 1=true  — NOT represented, see below
 *   bit 6  StatusStopOptim      (O) 0=false 1=true  — NOT represented, see below
 *   bit 7  HeatingDisabled      (O) 0=false 1=true
 *   bit 8  HeatCoolMode         (M) 0=cooling 1=heating — NOT represented, see below
 *   bit 9  StatusEcoC           (O) 0=false 1=true
 *   bit 10 StatusPreCool        (O) 0=false 1=true  — NOT represented, see below
 *   bit 11 CoolingDisabled      (O) 0=false 1=true
 *   bit 12 DewPointStatus       (O) 0=no alarm 1=alarm
 *   bit 13 FrostAlarm           (O) 0=no alarm 1=alarm
 *   bit 14 OverheatAlarm        (O) 0=no alarm 1=alarm
 *   bit 15 reserved             -- default 0
 *
 * § Phase 3.3A froze `HvacStatus`'s ten fields with exactly this bit mapping already
 * documented on each field (`packages/domain-model/src/capabilities.ts`) — this decoder
 * fills that existing, pre-mapped shape; it does not invent new correspondences.
 *
 * § Unmapped bits (§6 of the Phase 3.3C-4 spec — reported, not fabricated):
 *   - bit 4 StatusMorningBoostH, bit 5 StatusStartOptim, bit 6 StatusStopOptim,
 *     bit 10 StatusPreCool — no corresponding `HvacStatus` field exists; genuinely
 *     unrepresented information, not silently dropped-and-ignored-on-purpose.
 *   - bit 8 HeatCoolMode — same `0=cooling/1=heating` encoding as DPT 1.100 (§ Phase
 *     3.3C-3), but deliberately NOT routed into `TemperatureState.heatCool`: that field's
 *     sole authoritative producer is the independent DPT 1.100 `heatCool` hvacRole
 *     (§ Phase 3.3C-3's confirmed-state-authority discipline — one GA, one source of
 *     truth per field). Folding a second DPT's bit into the same universal field would
 *     make it ambiguous which telegram is authoritative when both are bound. `HvacStatus`
 *     has no field for it either, so this bit is read but not surfaced anywhere.
 *   - bit 15 reserved — always ignored.
 *
 * Each B16 group-value telegram carries the controller's COMPLETE current status (not a
 * delta) — group communication always transmits the whole encoded value, and the
 * canonical document's own "Encoding" note ("depending on the usage of this DPT... some
 * bit-fields may be unused and set to '0' by the sender") confirms unset bits are
 * meaningful zeroes, not "unchanged." So this decoder returns a fresh, COMPLETE
 * `HvacStatus` object every time (§10 — replace, never merge with a previously-decoded
 * one) — every represented bit is always present as an explicit `true`/`false`.
 */
export function decodeHvacStatus(value: KnxValue): HvacStatus | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
  const bit = (i: number) => ((n >> i) & 1) === 1;
  return {
    fault: bit(0),
    ecoHeatingActive: bit(1),
    flowTempLimitActive: bit(2),
    returnTempLimitActive: bit(3),
    heatingDisabled: bit(7),
    ecoCoolingActive: bit(9),
    coolingDisabled: bit(11),
    dewPointAlarm: bit(12),
    frostAlarm: bit(13),
    overheatAlarm: bit(14),
  };
}

/** `TemperatureState.setpoints`'s Comfort/Standby/Economy/BuildingProtection shape,
 * re-derived from the universal schema (§ Phase 3.3A), never duplicated by hand. */
type HvacSetpoints = NonNullable<Extract<CapabilityState, { kind: "temperature" }>["setpoints"]>;

/**
 * § Phase 3.3C-5B — the exact KNX 2-byte float (F16, "DPT9-family" encoding — same
 * sign/exponent/mantissa formula already used elsewhere for `DPT9.001`) decode of the
 * canonical raw sentinel `0x7FFFh` that DPT 222.100's own definition (KNX AS v02.02.01
 * §4.23.1) designates "invalid data" for each of its three fields independently:
 * byte0=0x7F (sign=0, exponent=1111b=15), byte1=0xFF (mantissa=011 1111 1111b=2047) →
 * `0.01 * 2047 * 2^15 = 670760.96`. Cross-verified against the real transport's own F16
 * decoder (`knxultimate`'s `src/utils.ts` `getFloat`) and its DPT222 subtype's own
 * declared range ceiling (`range: [-273, 670760]`) — not an invented constant. No real
 * HVAC setpoint can ever legitimately be 670760.96°C, so treating this exact value as
 * the invalid marker is safe and unambiguous.
 */
const INVALID_F16_SETPOINT = 670760.96;

function isKnxSetpoints(value: KnxValue): value is KnxSetpoints {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Partial<KnxSetpoints>).comfort === "number" &&
    typeof (value as Partial<KnxSetpoints>).standby === "number" &&
    typeof (value as Partial<KnxSetpoints>).economy === "number"
  );
}

/**
 * Decodes a raw KNX DPT 222.100 (`DPT_TempRoomSetpSetF16[3]`) value into the
 * Comfort/Standby/Economy subset of `TemperatureState.setpoints`. Each field is handled
 * INDEPENDENTLY: one field decoding to the invalid sentinel does not invalidate the
 * other two (§6 of the Phase 3.3C-5B spec) — that field simply becomes `null`, per this
 * codebase's existing nullable-field convention, never a fabricated `0` or a
 * silently-retained stale value. `buildingProtectionC` is deliberately absent from the
 * returned object — DPT 222.100 has no such field (unlike DPT 213.100), and fabricating
 * one here would misrepresent what this specific DPT actually carries.
 *
 * § REAL-TRANSPORT NOTE (honesty over convenience — see this driver's real
 * `wrapKnxUltimate()`): the real `knxultimate` transport's own DPT222 handler
 * (`dptlib.fromBuffer`) already fully decodes the raw 6 bytes into `{Comfort, Standby,
 * Economy}` floats before this driver ever sees the value — `KnxConnection.observe()`'s
 * contract is "decoded per DPT," so this driver has no raw-byte access at this layer for
 * ANY DPT, not just this one. Because `getFloat()` computes `0x7FFF` deterministically as
 * exactly `670760.96` (not a NaN/sentinel object), invalid-field detection HERE means
 * "compare the already-decoded float against that exact deterministic constant," not
 * "inspect the raw two bytes directly." This is real, not simulated — the real transport
 * really does decode 0x7FFF to 670760.96 every time — but it is worth stating plainly
 * that this driver relies on the decoded value rather than the raw wire bytes to
 * recognize the sentinel, since a hypothetical alternate DPT222 implementation that
 * decoded 0x7FFF differently (e.g. to `null` itself) would need this constant revisited.
 */
export function decodeHvacSetpoints(value: KnxValue): HvacSetpoints | null {
  if (!isKnxSetpoints(value)) return null;
  const field = (n: number): number | null => (Number.isFinite(n) && n !== INVALID_F16_SETPOINT ? n : null);
  return {
    comfortC: field(value.comfort),
    standbyC: field(value.standby),
    economyC: field(value.economy),
  };
}

/**
 * Encodes the Comfort/Standby/Economy subset of `TemperatureState.setpoints` into a raw
 * DPT 222.100 value (the real `knxultimate` DPT222 handler's own expected input shape).
 * § Codec completeness / test symmetry ONLY (§5 of the Phase 3.3C-5B spec) — this
 * function is never called from `command()` or any other SupremeOS command path: no
 * `setpoints` field exists on `TemperatureCapabilityCommand` (frozen, Phase 3.3A) for a
 * command to carry in the first place, so there is structurally no way to reach this
 * function from a device command this phase. `null`/missing fields encode back to the
 * canonical invalid sentinel.
 */
export function encodeHvacSetpoints(input: { comfortC: number | null; standbyC: number | null; economyC: number | null }): KnxSetpoints {
  const enc = (n: number | null): number => (n === null ? INVALID_F16_SETPOINT : n);
  return { comfort: enc(input.comfortC), standby: enc(input.standbyC), economy: enc(input.economyC) };
}

/** Hue 0..360, saturation 0..100, value(level) 0..100 → 0..255 RGB bytes. */
function hsvToRgb(h: number, s: number, v: number): KnxRgb {
  const sat = s / 100;
  const val = v / 100;
  const c = val * sat;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r, g, b] = [0, 0, 0];
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = val - c;
  return {
    red: Math.round((r + m) * 255),
    green: Math.round((g + m) * 255),
    blue: Math.round((b + m) * 255),
  };
}

/** 0..255 RGB bytes → hue 0..360, saturation 0..100, level(value) 0..100. */
function rgbToHsv(red: number, green: number, blue: number): { hue: number; saturation: number; level: number } {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const saturation = max === 0 ? 0 : (d / max) * 100;
  const level = max * 100;
  return { hue: Math.round(hue), saturation: Math.round(saturation), level: Math.round(level) };
}
