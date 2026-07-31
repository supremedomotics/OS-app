/**
 * Casambi Local Gateway — UDP Casambi Command wire codec (§ Casambi Driver Refactor — PR-2,
 * Local Gateway Foundation). Byte-exact encode/decode for the Lithernet gateway's "UDP Casambi
 * Command" operating mode (Lithernet_UDP_Developer_Reference.pdf §5.10), grounded directly in
 * the documented opcode tables and worked examples (e.g. `0.72.5.1e.1.ff.10.0\r\n` for "Set level
 * of a scene", `2.3a.1\r\n` for "Notify Node removed").
 *
 * Two on-wire text formats exist per the gateway's own "DEC or HEX" configuration field:
 * `hex-dot` (`Net_ID.Command_Direction.Length.Opcode.Args...\r\n`, lowercase hex, dot-separated)
 * and `dec-hash` (`Net_ID#Command_Direction#Length#Opcode#Args...\r\n`, decimal, hash-separated).
 * The reference doc's own examples are inconsistent about decimal zero-padding (§5.10.2.1.1's
 * `000#112#009#013#...` vs §5.10.2.2.4's `0#114#4#30#...`) — this codec never zero-pads on encode
 * (matching the majority of documented examples) and accepts either on decode via `parseInt`.
 *
 * "Notes on length" (p.264) states dec-hash MAY combine a multi-byte field (fade time, color
 * temperature, lux) into a single decimal token, shortening the packet. This codec deliberately
 * always encodes the fully-expanded, one-byte-per-token form — the doc explicitly allows this
 * ("Alternatively, it can also be transmitted as a high and low byte") for every such field, so
 * choosing it sidesteps the combining ambiguity entirely for everything we send. Decoding
 * therefore only re-derives struct `Packet { uint8_t length; uint8_t opcode; uint8_t
 * arguments[length-1]; }` (p.264) byte-for-byte and is NOT guaranteed correct if a real gateway,
 * configured for "dec with hash", emits the combined short form for a multi-byte field on an
 * incoming packet — a real, disclosed limitation, not a fabricated resolution.
 */

export type CasambiWireFormat = "hex-dot" | "dec-hash";

export type CasambiCommandDirection = "fromCasambi" | "toCasambi";

const DIRECTION_BYTE: Record<CasambiCommandDirection, number> = {
  fromCasambi: 0x70,
  toCasambi: 0x72,
};

const BYTE_DIRECTION: Record<number, CasambiCommandDirection> = {
  0x70: "fromCasambi",
  0x72: "toCasambi",
};

export interface CasambiPacket {
  netId: number;
  direction: CasambiCommandDirection;
  opcode: number;
  args: number[];
  /** `true` when the wire text carries a trailing `ACK` token (gateway "Send Ack" confirmation,
   * p.264: `0x_Net_ID.0x70.0x_Casambi_Data[1...X].ACK\r\n`). */
  ack?: boolean;
}

const SEPARATOR: Record<CasambiWireFormat, string> = {
  "hex-dot": ".",
  "dec-hash": "#",
};

function toToken(n: number, format: CasambiWireFormat): string {
  return format === "hex-dot" ? n.toString(16) : n.toString(10);
}

function fromToken(token: string, format: CasambiWireFormat): number {
  return format === "hex-dot" ? parseInt(token, 16) : parseInt(token, 10);
}

/** Broadcast Net ID (p.263: "ID 255 is reserved as a broadcast ID... can be used within commands
 * to address all gateways in the same network"). */
export const CASAMBI_BROADCAST_NET_ID = 255;

export function encodeCasambiPacket(packet: CasambiPacket, format: CasambiWireFormat = "hex-dot"): string {
  const sep = SEPARATOR[format];
  const length = 1 + packet.args.length; // struct Packet.length = opcode + arguments (p.264)
  const fields = [packet.netId, DIRECTION_BYTE[packet.direction], length, packet.opcode, ...packet.args].map((n) =>
    toToken(n, format),
  );
  return fields.join(sep) + "\r\n";
}

export function decodeCasambiPacket(raw: string, format: CasambiWireFormat = "hex-dot"): CasambiPacket {
  const sep = SEPARATOR[format];
  const trimmed = raw.replace(/\r?\n$/, "");
  const tokens = trimmed.split(sep);
  let ack = false;
  const lastToken = tokens[tokens.length - 1];
  if (lastToken !== undefined && lastToken.toUpperCase() === "ACK") {
    ack = true;
    tokens.pop();
  }
  if (tokens.length < 4) {
    throw new Error(`Malformed Casambi UDP packet (expected at least 4 fields, got ${tokens.length}): ${raw}`);
  }
  // Length already validated above (>= 4), so these four fields are provably present.
  const [netIdTok, dirTok, lengthTok, opcodeTok, ...argTokens] = tokens as [string, string, string, string, ...string[]];
  const netId = fromToken(netIdTok, format);
  const directionByte = fromToken(dirTok, format);
  const direction = BYTE_DIRECTION[directionByte];
  if (!direction) {
    throw new Error(`Unknown Casambi Command_Direction byte 0x${directionByte.toString(16)} in packet: ${raw}`);
  }
  const length = fromToken(lengthTok, format);
  const opcode = fromToken(opcodeTok, format);
  const allArgs = argTokens.map((t) => fromToken(t, format));
  const expectedArgCount = Math.max(0, length - 1);
  const args = allArgs.slice(0, expectedArgCount);
  return { netId, direction, opcode, args, ack };
}

/** Fade time is encoded on the wire as two bytes (low, high) in 10ms units (documented at every
 * opcode that has a `Duration`/fade-time field, e.g. p.285 "0x1E - Set level of a scene"). */
export function encodeFadeMs(ms: number): [low: number, high: number] {
  const units = Math.max(0, Math.round(ms / 10)) & 0xffff;
  return [units & 0xff, (units >> 8) & 0xff];
}

export function decodeFadeUnits(low: number, high: number): number {
  return ((high << 8) | low) * 10;
}

function encode16(value: number): [low: number, high: number] {
  const v = Math.max(0, Math.round(value)) & 0xffff;
  return [v & 0xff, (v >> 8) & 0xff];
}

function decode16(low: number, high: number): number {
  return (high << 8) | low;
}

/** Target_Type / Target_ID addressing scheme, identical across every targeted opcode
 * (p.288, p.295, p.297, p.302, p.304, p.306, p.309 — repeated verbatim in the source PDF). */
export const CASAMBI_TARGET_TYPE = {
  broadcast: 0,
  device: 1,
  /** Target_ID 0 = ungrouped devices; Target_ID 1-255 = a group address. Same Target_Type value
   * for both, disambiguated only by Target_ID — this is the documentation's own scheme, not an
   * inconsistency introduced here. */
  groupOrUngrouped: 2,
  sceneActiveOnly: 3,
  sceneAll: 4,
  manufacturer: 5,
} as const;
export type CasambiTargetType = (typeof CASAMBI_TARGET_TYPE)[keyof typeof CASAMBI_TARGET_TYPE];

// ---------------------------------------------------------------------------------------------
// Encoders — Commands TO the Casambi system (Command_Direction 0x72). §5.10.2.2.
// ---------------------------------------------------------------------------------------------

/** 0x10 - Push Button Pressed (p.282). Button_Number 0-3. */
export function encodePushButtonPressed(netId: number, buttonNumber: number): CasambiPacket {
  return { netId, direction: "toCasambi", opcode: 0x10, args: [buttonNumber] };
}

/** 0x11 - Push Button Released (p.283). Button_Number 0-3. */
export function encodePushButtonReleased(netId: number, buttonNumber: number): CasambiPacket {
  return { netId, direction: "toCasambi", opcode: 0x11, args: [buttonNumber] };
}

/** 0x1D - GetParameterValue (p.284). No arguments; triggers a burst of 0x1A/0x1B responses. */
export function encodeGetParameterValue(netId: number): CasambiPacket {
  return { netId, direction: "toCasambi", opcode: 0x1d, args: [] };
}

/** 0x1E - Set level of a scene (p.285). Fade time optional (omit to send only Scene/Level). */
export function encodeSetSceneLevel(netId: number, scene: number, level: number, fadeMs?: number): CasambiPacket {
  const args = fadeMs === undefined ? [scene, level] : [scene, level, ...encodeFadeMs(fadeMs)];
  return { netId, direction: "toCasambi", opcode: 0x1e, args };
}

/** 0x1F - Set level of a group (p.286). Fade time optional. */
export function encodeSetGroupLevel(netId: number, group: number, level: number, fadeMs?: number): CasambiPacket {
  const args = fadeMs === undefined ? [group, level] : [group, level, ...encodeFadeMs(fadeMs)];
  return { netId, direction: "toCasambi", opcode: 0x1f, args };
}

/** 0x20 - Set level of a target (p.287). Target can be broadcast/device/group/scene. Fade time
 * optional. */
export function encodeSetTargetLevel(
  netId: number,
  targetType: CasambiTargetType,
  targetId: number,
  level: number,
  fadeMs?: number,
): CasambiPacket {
  const args = fadeMs === undefined ? [level, targetType, targetId] : [level, ...encodeFadeMs(fadeMs), targetType, targetId];
  return { netId, direction: "toCasambi", opcode: 0x20, args };
}

/** 0x21 - Set the level of a button's target (p.289). Button_Number 0-3. */
export function encodeSetButtonLevel(netId: number, buttonNumber: number, level: number): CasambiPacket {
  return { netId, direction: "toCasambi", opcode: 0x21, args: [buttonNumber, level] };
}

/** 0x28 - Request time from the Casambi network (p.290). No arguments; response arrives as the
 * 0x28 "Time received" packet (see `parseTimeReceived`). */
export function encodeRequestTime(netId: number): CasambiPacket {
  return { netId, direction: "toCasambi", opcode: 0x28, args: [] };
}

/** 0x28 - Set time in the Casambi network (p.291). Same opcode as `encodeRequestTime`,
 * disambiguated by Length (0x01 request vs 0x08 set) exactly as the gateway itself does. */
export function encodeSetTime(
  netId: number,
  time: { yearHigh: number; yearLow: number; month: number; day: number; hour: number; minute: number; second: number },
): CasambiPacket {
  return {
    netId,
    direction: "toCasambi",
    opcode: 0x28,
    args: [time.yearHigh, time.yearLow, time.month, time.day, time.hour, time.minute, time.second],
  };
}

/** 0x2B - Set presence sensor (p.292). */
export function encodeSetPresenceSensor(netId: number, sensorState: number): CasambiPacket {
  return { netId, direction: "toCasambi", opcode: 0x2b, args: [sensorState] };
}

/** 0x2C - Set light sensor (p.293). 16-bit lux value, low byte first. */
export function encodeSetLightSensor(netId: number, luxValue: number): CasambiPacket {
  const [low, high] = encode16(luxValue);
  return { netId, direction: "toCasambi", opcode: 0x2c, args: [low, high] };
}

/**
 * 0x2F - Set color via RGBW (p.294). R/G/B/W/Level 0-254; W=255 ignores white, Level=255 ignores
 * level (documented special values).
 *
 * DOCUMENTATION INCONSISTENCY (flagged, not silently resolved): the doc's own worked example
 * reads `0.72.7.2f.ff.0.0.ff.1.1.ff\r\n` — a Length token of `7` immediately followed by 7 data
 * bytes (R,G,B,W,Type,ID,Level). That contradicts the doc's own universal framing rule (p.264:
 * `length = opcode + arguments`, i.e. 1 + 7 = 8), and the identical off-by-one recurs verbatim in
 * `encodeSetColorHueSat`'s (0x3D) own worked example. This codec always derives Length from that
 * universal formula via `encodeCasambiPacket`, never from a per-opcode caption, so it emits `8`
 * here — the value consistent with the actual field data and every other multi-field opcode in
 * this file, not the doc's likely-typo'd caption. See `udp-codec.test.ts` for the byte-exact case.
 */
export function encodeSetColorRGBW(
  netId: number,
  targetType: CasambiTargetType,
  targetId: number,
  color: { r: number; g: number; b: number; w: number; level?: number },
): CasambiPacket {
  return {
    netId,
    direction: "toCasambi",
    opcode: 0x2f,
    args: [color.r, color.g, color.b, color.w, targetType, targetId, color.level ?? 255],
  };
}

/** 0x31 - SetTargetVerticalRatio (p.296). Fade time optional. */
export function encodeSetTargetVerticalRatio(
  netId: number,
  targetType: CasambiTargetType,
  targetId: number,
  ratio: number,
  fadeMs?: number,
): CasambiPacket {
  const args = fadeMs === undefined ? [ratio, targetType, targetId] : [ratio, ...encodeFadeMs(fadeMs), targetType, targetId];
  return { netId, direction: "toCasambi", opcode: 0x31, args };
}

/** 0x38 - Set color via X/Y (p.298). X/Y are 16-bit (0-65535), Level 0-254 (255 = ignore level). */
export function encodeSetColorXY(
  netId: number,
  targetType: CasambiTargetType,
  targetId: number,
  color: { x: number; y: number; level?: number },
): CasambiPacket {
  const [xLow, xHigh] = encode16(color.x);
  const [yLow, yHigh] = encode16(color.y);
  return {
    netId,
    direction: "toCasambi",
    opcode: 0x38,
    args: [xHigh, xLow, yHigh, yLow, targetType, targetId, color.level ?? 255],
  };
}

/** Node status query Request values (p.300). */
export const CASAMBI_NODE_STATUS_REQUEST = {
  disableAutoNotify: 0x00,
  /** 0x01-0xFB: query a specific unit by its unit ID. */
  enableAllNodes: 0xfe,
  /** Own-node status query — the only read-only, never-actuating request value; used by
   * `local-transport`'s Test Connection probe (never a real device/group/scene target). */
  ownNode: 0xff,
} as const;

/** 0x39 - Node status query (p.300). Only Evolution firmware. Doc's own caution: "Queries should
 * not be sent too quickly in succession... Only a single unit should be queried per request." */
export function encodeNodeStatusRequest(netId: number, request: number): CasambiPacket {
  return { netId, direction: "toCasambi", opcode: 0x39, args: [request] };
}

/** 0x3D - Set color via Hue/Sat (p.301). Hue 0-65535, Sat/W/Level 0-254 (W=255/Level=255 ignore).
 * Shares the same Length-caption inconsistency as `encodeSetColorRGBW` above — see its doc
 * comment; this codec emits the formula-consistent Length here too. */
export function encodeSetColorHueSat(
  netId: number,
  targetType: CasambiTargetType,
  targetId: number,
  color: { hue: number; sat: number; w?: number; level?: number },
): CasambiPacket {
  const [hueLow, hueHigh] = encode16(color.hue);
  return {
    netId,
    direction: "toCasambi",
    opcode: 0x3d,
    args: [hueHigh, hueLow, color.sat, color.w ?? 255, targetType, targetId, color.level ?? 255],
  };
}

export interface CasambiDimmerPair {
  /** Dimmer channel index, 0-3. */
  index: number;
  value: number;
}

/** 0x3E - SetTargetDimmers (p.303). Up to 4 (index, value) pairs; fadeMs=0 uses the Casambi app's
 * own default per the doc's special case. */
export function encodeSetTargetDimmers(
  netId: number,
  targetType: CasambiTargetType,
  targetId: number,
  dimmers: CasambiDimmerPair[],
  fadeMs = 0,
): CasambiPacket {
  const [durLow, durHigh] = encodeFadeMs(fadeMs);
  const pairArgs = dimmers.flatMap((d) => [d.index, d.value]);
  return { netId, direction: "toCasambi", opcode: 0x3e, args: [targetType, targetId, durLow, durHigh, ...pairArgs] };
}

/**
 * 0x3F - SetTargetElements (p.305). Up to 8 (index, value) pairs.
 *
 * DOCUMENTATION INCONSISTENCY (flagged, not silently resolved): the source PDF's own section
 * heading reads "5.10.2.2.18. 0x3F - SetTargetElements" but its "Telegram parameters" body
 * states "Opcode: 0x3E (decimal 62)" — the same opcode as `encodeSetTargetDimmers` immediately
 * above it. Both commands otherwise share an identical wire shape (TargetType.TargetID.
 * Duration_low.Duration_high.[Index.Value]...), so this may be a copy-paste error in the doc
 * rather than a real second command. We follow the section title (0x3F) here since "Elements"
 * (custom elements, index 0-7) and "Dimmers" (dimmer channels, index 0-3) are described as
 * distinct concepts with different index ranges, and the gateway must have some way to
 * distinguish them on the wire. This is a judgment call, not a verified fact — see TODO.md.
 */
export function encodeSetTargetElements(
  netId: number,
  targetType: CasambiTargetType,
  targetId: number,
  elements: CasambiDimmerPair[],
  fadeMs = 0,
): CasambiPacket {
  const [durLow, durHigh] = encodeFadeMs(fadeMs);
  const pairArgs = elements.flatMap((e) => [e.index, e.value]);
  return { netId, direction: "toCasambi", opcode: 0x3f, args: [targetType, targetId, durLow, durHigh, ...pairArgs] };
}

/** 0x45 - Scene status query (p.307). Only Evolution firmware >= 33.22. */
export function encodeSceneStatusRequest(netId: number, sceneId: number): CasambiPacket {
  return { netId, direction: "toCasambi", opcode: 0x45, args: [sceneId] };
}

/** 0x46 - Target status query (p.308). Field order is Target_ID THEN Target_Type, the reverse of
 * every other targeted opcode in this file — documented as such (p.308), not an error here. Only
 * Evolution firmware >= 34.50. */
export function encodeTargetStatusRequest(netId: number, targetId: number, targetType: CasambiTargetType): CasambiPacket {
  return { netId, direction: "toCasambi", opcode: 0x46, args: [targetId, targetType] };
}

/** Color temperature (Tc) special encodings (p.310). */
export const CASAMBI_TC = {
  /** 0x00 = warmest possible value. */
  warmest: 0x00,
} as const;

/** 0x48 - Set color temperature (p.309). Tc is either Kelvin (0x400-0x4000) or a normalized
 * 0x00-0xFF value; fade time is NOT optional for this opcode (per the doc). Only Evolution
 * firmware >= 36.70. */
export function encodeSetColorTemperature(
  netId: number,
  targetType: CasambiTargetType,
  targetId: number,
  tc: number,
  fadeMs: number,
): CasambiPacket {
  const [tcLow, tcHigh] = encode16(tc);
  const [durLow, durHigh] = encodeFadeMs(fadeMs);
  return { netId, direction: "toCasambi", opcode: 0x48, args: [tcLow, tcHigh, durLow, durHigh, targetType, targetId] };
}

/** 0x49 - Target Color query (p.311). `responseSize` should be 15 for complete color info. Only
 * Evolution firmware >= 37.80. */
export function encodeTargetColorRequest(
  netId: number,
  targetType: CasambiTargetType,
  targetId: number,
  responseSize = 15,
): CasambiPacket {
  return { netId, direction: "toCasambi", opcode: 0x49, args: [targetType, targetId, responseSize] };
}

/** 0x4A - Resume Automation (p.313). Reactivates automatic control after a manual override. Only
 * Evolution firmware >= 37.90. */
export function encodeResumeAutomation(netId: number, targetType: CasambiTargetType, targetId: number): CasambiPacket {
  return { netId, direction: "toCasambi", opcode: 0x4a, args: [targetType, targetId] };
}

/** 0x4B NotifyControlValues Request values (p.314). */
export const CASAMBI_NOTIFY_CONTROL_REQUEST = {
  unsubscribe: 0,
  subscribe: 1,
  read: 2,
  setDefaultMask: 3,
} as const;

/** 0x4B - NotifyControlValues: SetDefaultMask (p.314). Fixed documented mask `3.0.0.FF.FF.FF.FF`.
 * Recommended to send once before Subscribe/Read. Only Evolution firmware >= 37.90. */
export function encodeNotifyControlValuesSetDefaultMask(netId: number): CasambiPacket {
  return {
    netId,
    direction: "toCasambi",
    opcode: 0x4b,
    args: [CASAMBI_NOTIFY_CONTROL_REQUEST.setDefaultMask, 0, 0, 0xff, 0xff, 0xff, 0xff],
  };
}

/** 0x4B - NotifyControlValues: Subscribe (p.314). Target_ID 0 = all devices, 1-250 = a device. */
export function encodeNotifyControlValuesSubscribe(netId: number, targetIdMin: number, targetIdMax: number): CasambiPacket {
  return {
    netId,
    direction: "toCasambi",
    opcode: 0x4b,
    args: [CASAMBI_NOTIFY_CONTROL_REQUEST.subscribe, targetIdMin, targetIdMax],
  };
}

/** 0x4B - NotifyControlValues: Unsubscribe (p.314). */
export function encodeNotifyControlValuesUnsubscribe(netId: number, targetIdMin: number, targetIdMax: number): CasambiPacket {
  return {
    netId,
    direction: "toCasambi",
    opcode: 0x4b,
    args: [CASAMBI_NOTIFY_CONTROL_REQUEST.unsubscribe, targetIdMin, targetIdMax],
  };
}

/** 0x4B - NotifyControlValues: Read (one-time query, p.314). */
export function encodeNotifyControlValuesRead(netId: number, targetIdMin: number, targetIdMax: number): CasambiPacket {
  return {
    netId,
    direction: "toCasambi",
    opcode: 0x4b,
    args: [CASAMBI_NOTIFY_CONTROL_REQUEST.read, targetIdMin, targetIdMax],
  };
}

/** 0x50 - NotifyButtonEvent enable/disable (p.316). Only Evolution firmware >= 39.50. */
export function encodeNotifyButtonEvent(netId: number, enable: boolean): CasambiPacket {
  return { netId, direction: "toCasambi", opcode: 0x50, args: [enable ? 0xfd : 0] };
}

// ---------------------------------------------------------------------------------------------
// Parsers — Commands FROM the Casambi system (Command_Direction 0x70). §5.10.2.1.
// ---------------------------------------------------------------------------------------------

function assertOpcode(packet: CasambiPacket, expected: number, name: string): void {
  if (packet.opcode !== expected) {
    throw new Error(`${name}: expected opcode 0x${expected.toString(16)}, got 0x${packet.opcode.toString(16)}`);
  }
}

/**
 * Pads `args` to at least `T`'s length with 0 and returns it as that fixed-length tuple, so
 * parsers can safely destructure a fixed-shape field list even from a truncated/malformed packet
 * — this module's boundary posture for untrusted wire input is "never crash, never silently
 * fabricate a non-zero value" (§ CLAUDE.md "treat all external/protocol input as untrusted at the
 * SIL boundary"). The cast is honest, not a lie to the type checker: the padding immediately
 * above guarantees at least `length` real elements before the cast is applied.
 */
function padArgs<T extends number[]>(args: readonly number[], length: T["length"]): T {
  const padded = args.length >= length ? args.slice(0, length) : [...args, ...new Array(length - args.length).fill(0)];
  return padded as T;
}

export interface CasambiSceneCalled {
  bits: [number, number, number, number, number, number, number, number];
}

/** 0x0D - Scene called (p.266). Length 9: 8 configurable Bit_1..Bit_8 slide-switch values. */
export function parseSceneCalled(packet: CasambiPacket): CasambiSceneCalled {
  assertOpcode(packet, 0x0d, "parseSceneCalled");
  const [b1, b2, b3, b4, b5, b6, b7, b8] = padArgs<
    [number, number, number, number, number, number, number, number]
  >(packet.args, 8);
  return { bits: [b1, b2, b3, b4, b5, b6, b7, b8] };
}

export type CasambiParameterResponse =
  | { kind: "parameterValue"; parameterNumber: number; parameterValue: number }
  | { kind: "parametersComplete" };

/**
 * 0x1A/0x1B - SetParameterValue / ParametersComplete (p.267-268).
 *
 * DOCUMENTATION INCONSISTENCY (flagged, not silently resolved): the source PDF's section
 * heading for the first message reads "5.10.2.1.2. 0x1A - SetParameterValue" but its own
 * "Telegram parameters" body states "Opcode: 0x1B (decimal 27)" — identical to the very next
 * section's opcode for the unrelated "ParametersComplete" marker message. Both are genuinely
 * responses to `encodeGetParameterValue` (0x1D), so opcode 0x1B is legitimately overloaded; the
 * only reliable disambiguator the doc provides is Length (SetParameterValue: Length 0x03, two
 * data args; ParametersComplete: Length 0x01, zero data args) — used here exactly as the two
 * sections themselves specify, rather than trusting the (self-contradictory) opcode field alone.
 */
export function parseParameterResponse(packet: CasambiPacket): CasambiParameterResponse {
  if (packet.opcode !== 0x1a && packet.opcode !== 0x1b) {
    throw new Error(`parseParameterResponse: expected opcode 0x1a or 0x1b, got 0x${packet.opcode.toString(16)}`);
  }
  if (packet.args.length === 0) {
    return { kind: "parametersComplete" };
  }
  const [parameterNumber, parameterValue] = padArgs<[number, number]>(packet.args, 2);
  return { kind: "parameterValue", parameterNumber, parameterValue };
}

export interface CasambiTimeReceived {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 0x28 - Time received from the Casambi network (p.269). Length 8: year_high/low, month, day,
 * hour, minute, second. */
export function parseTimeReceived(packet: CasambiPacket): CasambiTimeReceived {
  assertOpcode(packet, 0x28, "parseTimeReceived");
  const [yearHigh, yearLow, month, day, hour, minute, second] = padArgs<
    [number, number, number, number, number, number, number]
  >(packet.args, 7);
  return { year: decode16(yearLow, yearHigh), month, day, hour, minute, second };
}

/** Node condition codes (p.271). */
export const CASAMBI_NODE_CONDITION: Record<number, string> = {
  0x00: "ok",
  0x80: "ok",
  0xa0: "ok",
  0x01: "overheated",
  0x09: "overload",
  0x81: "thermal_overload",
  0x82: "lamp_failure",
  0x83: "driver_failure",
  0x85: "incompatible_hw",
  0x86: "hw_not_found",
  0x87: "configuration_failed",
};

export interface CasambiNodeStatus {
  unitId: number;
  scene: number;
  /** 0-15, the 6 least-significant bits of Priority_Node_Type (p.270). */
  priority: number;
  /** 0-3, the 2 most-significant bits of Priority_Node_Type. 0/1=active node, 2=switch(passive),
   * 3=sensor(passive). */
  nodeType: number;
  condition: number;
  conditionLabel: string | undefined;
  online: number;
}

/** 0x39 - Node Status (p.270). Length 6: Unit_ID, Scene, Priority_Node_Type, Condition, Online.
 * May arrive as a burst of several messages in succession. */
export function parseNodeStatus(packet: CasambiPacket): CasambiNodeStatus {
  assertOpcode(packet, 0x39, "parseNodeStatus");
  const [unitId, scene, priorityNodeType, condition, online] = padArgs<
    [number, number, number, number, number]
  >(packet.args, 5);
  return {
    unitId,
    scene,
    priority: priorityNodeType & 0x3f,
    nodeType: (priorityNodeType >> 6) & 0x03,
    condition,
    conditionLabel: CASAMBI_NODE_CONDITION[condition],
    online,
  };
}

export interface CasambiNodeRemoved {
  unitId: number;
}

/** 0x3A - Notify Node removed (p.272). Also occurs when querying a unit ID that no longer exists
 * — the caller should remove/mark-absent the corresponding entity either way, per the doc. */
export function parseNodeRemoved(packet: CasambiPacket): CasambiNodeRemoved {
  assertOpcode(packet, 0x3a, "parseNodeRemoved");
  const [unitId] = padArgs<[number]>(packet.args, 1);
  return { unitId };
}

export interface CasambiSceneStatus {
  scene: number;
  active: boolean;
  level: number;
}

/** 0x45 - Scene Status (p.273). Length 4: Scene, Active (bit 0), Level. */
export function parseSceneStatus(packet: CasambiPacket): CasambiSceneStatus {
  assertOpcode(packet, 0x45, "parseSceneStatus");
  const [scene, active, level] = padArgs<[number, number, number]>(packet.args, 3);
  return { scene, active: (active & 0x01) === 1, level };
}

export interface CasambiTargetStatus {
  targetId: number;
  level: number;
  lastLevel: number;
  cctLevel: number;
  targetType: number;
  verticalRatio: number;
}

/** 0x46 - Target Status (p.274). Length 7. Only Evolution firmware >= 36.70. */
export function parseTargetStatus(packet: CasambiPacket): CasambiTargetStatus {
  assertOpcode(packet, 0x46, "parseTargetStatus");
  const [targetId, level, lastLevel, cctLevel, targetType, verticalRatio] = padArgs<
    [number, number, number, number, number, number]
  >(packet.args, 6);
  return { targetId, level, lastLevel, cctLevel, targetType, verticalRatio };
}

export interface CasambiTargetColor {
  targetType: number;
  targetId: number;
  level: number;
  r: number;
  g: number;
  b: number;
  w: number;
  hue: number;
  sat: number;
  x: number;
  y: number;
  levelXy: number;
}

/** 0x49 - Target Color (p.275). Length 0x15 (21) or the length requested by the original 0x49
 * query — fields beyond what's present are left `undefined`. Only Evolution firmware >= 36.70. */
export function parseTargetColor(packet: CasambiPacket): Partial<CasambiTargetColor> {
  assertOpcode(packet, 0x49, "parseTargetColor");
  // Only the first 7 fields (through W) are guaranteed by the minimum documented response; the
  // rest (hue/sat/xy/levelXy) are genuinely variable-length per the original query's requested
  // size (p.275), so they stay `number | undefined` and are only added to `result` when present.
  const [targetType, targetId, level, r, g, b, w] = padArgs<[number, number, number, number, number, number, number]>(
    packet.args,
    7,
  );
  const [, , , , , , , hueHigh, hueLow, sat, xHigh, xLow, yHigh, yLow, levelXy] = packet.args;
  const result: Partial<CasambiTargetColor> = { targetType, targetId, level, r, g, b, w };
  if (hueHigh !== undefined && hueLow !== undefined) result.hue = decode16(hueLow, hueHigh);
  if (sat !== undefined) result.sat = sat;
  if (xHigh !== undefined && xLow !== undefined) result.x = decode16(xLow, xHigh);
  if (yHigh !== undefined && yLow !== undefined) result.y = decode16(yLow, yHigh);
  if (levelXy !== undefined) result.levelXy = levelXy;
  return result;
}

export interface CasambiButtonEvent {
  unitId: number;
  source: number;
  button: number;
  event: number;
  eventLabel: string | undefined;
}

/** Button event types (p.279). Doc notes other event types exist but are "not currently
 * exported" — only these three are documented. */
export const CASAMBI_BUTTON_EVENT: Record<number, string> = {
  2: "short_press",
  9: "long_press_start",
  12: "long_press_end",
};

/** 0x51 - NotifyButtonEvent Responses (p.279). Length 5: Unit_ID, Source, Button (0-7), Event.
 * Only Evolution firmware >= 39.50, and only after `encodeNotifyButtonEvent(netId, true)`. */
export function parseButtonEvent(packet: CasambiPacket): CasambiButtonEvent {
  assertOpcode(packet, 0x51, "parseButtonEvent");
  const [unitId, source, button, event] = padArgs<[number, number, number, number]>(packet.args, 4);
  return { unitId, source, button, event, eventLabel: CASAMBI_BUTTON_EVENT[event] };
}

// ---------------------------------------------------------------------------------------------
// 0x4B - NotifyControlValues Responses (p.276-278). Type/value pairs describing a target's
// current control values (dimmer channel, color temperature, battery, presence, lux, etc).
// ---------------------------------------------------------------------------------------------

interface ControlTypeInfo {
  name: string;
  /** Fixed short-form size in bytes, or `null` when the doc leaves the short-form size
   * genuinely ambiguous (type 14 — see `parseNotifyControlValues`'s doc comment). */
  size: number | null;
}

/** Control Type IDs, short-form (type < 0x80) sizes per the doc's table (p.277-278). Long-form
 * (0x80-bit set) variants of the indexed types (129/142/143/144/145/146) are handled separately
 * in `parseNotifyControlValues` since they carry an explicit INDEX + LEN instead of a fixed size. */
export const CASAMBI_CONTROL_TYPE: Record<number, ControlTypeInfo> = {
  1: { name: "dimmerChannel", size: 1 },
  2: { name: "colorTemperature", size: 1 },
  3: { name: "hueSaturation", size: 3 },
  4: { name: "xyColor", size: 4 },
  5: { name: "colorSourceSelector", size: 1 },
  6: { name: "deviceTemperature", size: 1 },
  7: { name: "batteryLevel", size: 1 },
  8: { name: "overheatingIndicator", size: 1 },
  9: { name: "generalErrorIndicator", size: 1 },
  10: { name: "verticalControl", size: 1 },
  11: { name: "whiteChannel", size: 1 },
  // 12, 13: reserved / not used (p.277) — never emitted, no entry needed.
  14: { name: "sensorField", size: null },
  15: { name: "slider", size: 2 },
  16: { name: "onOffToggle", size: 1 },
  17: { name: "button", size: 1 },
  18: { name: "pushButton", size: 1 },
  19: { name: "whiteColorMatch", size: 1 },
  20: { name: "lightSensorLux", size: 2 },
  21: { name: "presenceSensor", size: 1 },
};

export interface CasambiControlValue {
  type: number;
  typeName: string;
  /** Present for long-form entries (0x80 bit set on the wire type), e.g. an indexed slider or
   * dimmer channel. */
  index?: number;
  /** Raw value bytes, little-endian order as received. */
  valueBytes: number[];
}

export interface CasambiNotifyControlValues {
  targetId: number;
  values: CasambiControlValue[];
  /** `true` if parsing stopped early because an ambiguous short-form type (14) was encountered
   * with no way to know its byte length — an honest gap, not a fabricated resolution. See the
   * doc's own text: type 14/142 "Sensor field... requires INDEX specification for
   * interpretation," which the short form (type < 0x80) never carries. */
  truncated: boolean;
}

/**
 * 0x4B - NotifyControlValues Responses (p.276-278). Length variable; Target_ID followed by a
 * list of (type, value) pairs — short form `TYPE:VALUE` for types < 0x80, long form
 * `TYPE|0x80:INDEX:LEN:VALUE[len]` for the indexed variants (129/142/143/144/145/146).
 *
 * Only Evolution firmware >= 37.90. Only a single Casambi driver capability (NotifyControlValues
 * subscription) actually emits data this parser consumes — see `services/protocols/src/core/
 * capability-engine.ts`'s doc comment on why this is the mechanism Local-mode discovery uses to
 * infer a unit's Supreme capabilities, since no REST device-listing endpoint exists.
 */
export function parseNotifyControlValues(packet: CasambiPacket): CasambiNotifyControlValues {
  assertOpcode(packet, 0x4b, "parseNotifyControlValues");
  const targetId = packet.args[0] ?? 0;
  const rest = packet.args.slice(1);
  const values: CasambiControlValue[] = [];
  let i = 0;
  let truncated = false;
  while (i < rest.length) {
    const rawType = rest[i++];
    if (rawType === undefined) break;
    const isLongForm = (rawType & 0x80) !== 0;
    const shortType = rawType & 0x7f;
    const info = CASAMBI_CONTROL_TYPE[shortType];
    const typeName = info?.name ?? `unknown_${shortType}`;

    if (isLongForm) {
      const index = rest[i++];
      const len = rest[i++];
      if (index === undefined || len === undefined) {
        truncated = true;
        break;
      }
      const valueBytes = rest.slice(i, i + len);
      i += len;
      values.push({ type: rawType, typeName, index, valueBytes });
      continue;
    }

    if (info?.size == null) {
      // Type 14 short-form: doc gives no fixed size and no INDEX/LEN to derive one from.
      // Stop here rather than guess a byte count that could desync the remainder of the message.
      truncated = true;
      break;
    }
    const valueBytes = rest.slice(i, i + info.size);
    i += info.size;
    values.push({ type: rawType, typeName, valueBytes });
  }
  return { targetId, values, truncated };
}
