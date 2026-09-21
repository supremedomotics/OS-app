/**
 * Minimal hand-rolled protobuf (proto2) wire codec for the specific MRP messages this
 * driver uses (§ Apple TV Phase 2B — MRP transport). No protobuf compiler/runtime
 * dependency is added: MRP's `ProtocolMessage` uses a small, fixed set of fields (each
 * message "type" is really just another top-level field, via proto2 extensions, which
 * are wire-format-identical to regular fields) — a generic varint/length-delimited
 * writer+reader covers all of it. Every field number, message-type enum value, and byte
 * layout below is copied from pyatv's real, canonical `.proto` sources and Python
 * implementation (Apache-2.0, `pyatv/protocols/mrp/protobuf/*.proto` and
 * `pyatv/protocols/mrp/messages.py`), fetched and inspected directly during this phase —
 * not recalled from memory, not guessed.
 */

// --- Generic protobuf wire primitives (proto2, wire types 0/2 only — varint + bytes). ---

export function encodeVarint(value: number): Buffer {
  if (value < 0 || !Number.isFinite(value)) throw new Error(`mrp-protobuf: invalid varint value ${value}`);
  let n = BigInt(Math.trunc(value));
  const bytes: number[] = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0n);
  return Buffer.from(bytes);
}

/** Reads a varint starting at `offset`; returns the value and the next offset. */
export function decodeVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  for (;;) {
    if (i >= buf.length) throw new Error("mrp-protobuf: truncated varint");
    const byte = buf[i]!;
    result |= BigInt(byte & 0x7f) << shift;
    i += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: Number(result), next: i };
}

function tag(fieldNumber: number, wireType: 0 | 2): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

/** Encodes one length-delimited (wire type 2) field: bytes or embedded message. */
export function fieldBytes(fieldNumber: number, value: Buffer): Buffer {
  return Buffer.concat([tag(fieldNumber, 2), encodeVarint(value.length), value]);
}

export function fieldString(fieldNumber: number, value: string): Buffer {
  return fieldBytes(fieldNumber, Buffer.from(value, "utf8"));
}

/** Encodes one varint (wire type 0) field — covers proto2 int32/uint32/uint64/bool/enum. */
export function fieldVarint(fieldNumber: number, value: number | boolean): Buffer {
  const n = typeof value === "boolean" ? (value ? 1 : 0) : value;
  return Buffer.concat([tag(fieldNumber, 0), encodeVarint(n)]);
}

export interface RawField {
  fieldNumber: number;
  wireType: 0 | 2;
  value: Buffer | number;
}

/** Decodes a flat top-level list of fields (does not recurse into embedded messages —
 * callers re-invoke this on a field's raw bytes when they know it's a submessage). */
export function decodeFields(buf: Buffer): RawField[] {
  const fields: RawField[] = [];
  let i = 0;
  while (i < buf.length) {
    const { value: key, next } = decodeVarint(buf, i);
    i = next;
    const fieldNumber = key >>> 3;
    const wireType = (key & 0x7) as 0 | 2;
    if (wireType === 0) {
      const { value, next: next2 } = decodeVarint(buf, i);
      i = next2;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === 2) {
      const { value: len, next: next2 } = decodeVarint(buf, i);
      i = next2;
      if (i + len > buf.length) throw new Error("mrp-protobuf: truncated length-delimited field");
      fields.push({ fieldNumber, wireType, value: buf.subarray(i, i + len) });
      i += len;
    } else {
      throw new Error(`mrp-protobuf: unsupported wire type ${wireType} (field ${fieldNumber})`);
    }
  }
  return fields;
}

/** Convenience: last-value-wins map of fieldNumber -> value (proto2 "optional" semantics —
 * a repeated write of the same field means "the last one wins", which is what every MRP
 * message this driver reads/writes actually needs). */
export function fieldMap(buf: Buffer): Map<number, Buffer | number> {
  const m = new Map<number, Buffer | number>();
  for (const f of decodeFields(buf)) m.set(f.fieldNumber, f.value);
  return m;
}

export function getString(m: Map<number, Buffer | number>, fieldNumber: number): string | null {
  const v = m.get(fieldNumber);
  return v instanceof Buffer ? v.toString("utf8") : null;
}
export function getBytes(m: Map<number, Buffer | number>, fieldNumber: number): Buffer | null {
  const v = m.get(fieldNumber);
  return v instanceof Buffer ? v : null;
}
export function getVarint(m: Map<number, Buffer | number>, fieldNumber: number): number | null {
  const v = m.get(fieldNumber);
  return typeof v === "number" ? v : null;
}

// --- MRP ProtocolMessage: verified field numbers (pyatv ProtocolMessage.proto). ---

export const enum MrpType {
  SEND_COMMAND_MESSAGE = 1,
  SET_STATE_MESSAGE = 4,
  REGISTER_HID_DEVICE_MESSAGE = 6,
  SEND_HID_EVENT_MESSAGE = 8,
  DEVICE_INFO_MESSAGE = 15,
  CLIENT_UPDATES_CONFIG_MESSAGE = 16,
  CRYPTO_PAIRING_MESSAGE = 34,
  PLAYBACK_QUEUE_REQUEST_MESSAGE = 32,
  DEVICE_INFO_UPDATE_MESSAGE = 37,
  WAKE_DEVICE_MESSAGE = 41,
}

/** `ProtocolMessage`'s own top-level field numbers, plus every submessage's `extend
 * ProtocolMessage { optional X x = N; }` field number this driver uses — all verified
 * directly against the real `.proto` sources (see module doc comment). */
export const MrpField = {
  type: 1,
  identifier: 2,
  authenticationToken: 3,
  errorCode: 4,
  timestamp: 5,
  errorDescription: 78,
  uniqueIdentifier: 85,
  // extend ProtocolMessage { ... = N }
  sendCommandMessage: 6,
  setStateMessage: 9,
  sendHIDEventMessage: 13,
  deviceInfoMessage: 20,
  clientUpdatesConfigMessage: 21,
  cryptoPairingMessage: 39,
  playbackQueueRequestMessage: 37,
} as const;

/** Build a top-level `ProtocolMessage`: `type` + one embedded submessage field + a fresh
 * `uniqueIdentifier` (pyatv's `messages.create()` always sets a random UUID here — some
 * Apple TV firmware is intolerant of a missing one). */
export function buildProtocolMessage(type: MrpType, submessageField: number, submessage: Buffer): Buffer {
  return Buffer.concat([
    fieldVarint(MrpField.type, type),
    fieldString(MrpField.uniqueIdentifier, randomUuid()),
    fieldBytes(submessageField, submessage),
  ]);
}

function randomUuid(): string {
  // Node >=14.17 has crypto.randomUUID; avoided importing node:crypto here to keep this
  // module dependency-free — a simple RFC4122-shaped v4 fallback is sufficient since MRP
  // only needs *a* unique-looking string, never parses it as a real UUID.
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`.toUpperCase();
}

// --- DeviceInfoMessage (field numbers verified against DeviceInfoMessage.proto). ---

export interface MrpDeviceInfo {
  uniqueIdentifier: string;
  name: string;
  systemBuildVersion: string;
  applicationBundleIdentifier: string;
  protocolVersion: number;
}

const DeviceInfoField = {
  uniqueIdentifier: 1,
  name: 2,
  systemBuildVersion: 4,
  applicationBundleIdentifier: 5,
  protocolVersion: 7,
} as const;

/** Verified verbatim against pyatv's `messages.device_information()` — every field it
 * sets, same values where they're protocol constants (not per-install identity). */
export function buildDeviceInfoMessage(info: MrpDeviceInfo): Buffer {
  const inner = Buffer.concat([
    fieldVarint(19, true), // allowsPairing (field number per DeviceInfoMessage.proto)
    fieldString(DeviceInfoField.applicationBundleIdentifier, info.applicationBundleIdentifier),
    fieldString(DeviceInfoField.systemBuildVersion, info.systemBuildVersion),
    fieldString(DeviceInfoField.name, info.name),
    fieldVarint(DeviceInfoField.protocolVersion, info.protocolVersion),
    fieldString(DeviceInfoField.uniqueIdentifier, info.uniqueIdentifier),
  ]);
  return buildProtocolMessage(MrpType.DEVICE_INFO_MESSAGE, MrpField.deviceInfoMessage, inner);
}

// --- CryptoPairingMessage (verified: pairingData=1, status=2, state=5). ---

export function buildCryptoPairingMessage(pairingDataTlv8: Buffer, state: 0 | 2): Buffer {
  const inner = Buffer.concat([
    fieldBytes(1, pairingDataTlv8), // pairingData
    fieldVarint(2, 0), // status
    fieldVarint(3, false), // isRetrying
    fieldVarint(4, false), // isUsingSystemPairing
    fieldVarint(5, state), // state
  ]);
  return buildProtocolMessage(MrpType.CRYPTO_PAIRING_MESSAGE, MrpField.cryptoPairingMessage, inner);
}

export function extractCryptoPairingData(protocolMessage: Buffer): Buffer {
  const top = fieldMap(protocolMessage);
  const cryptoBuf = getBytes(top, MrpField.cryptoPairingMessage);
  if (!cryptoBuf) throw new Error("mrp-protobuf: message has no cryptoPairingMessage field");
  const inner = fieldMap(cryptoBuf);
  const pairingData = getBytes(inner, 1);
  if (!pairingData) throw new Error("mrp-protobuf: cryptoPairingMessage has no pairingData");
  return pairingData;
}

// --- ClientUpdatesConfigMessage (verified field numbers 1-5). ---

export function buildClientUpdatesConfigMessage(opts: {
  artwork?: boolean;
  nowPlaying?: boolean;
  volume?: boolean;
  keyboard?: boolean;
  outputDevice?: boolean;
}): Buffer {
  const inner = Buffer.concat([
    fieldVarint(1, opts.artwork ?? true),
    fieldVarint(2, opts.nowPlaying ?? true),
    fieldVarint(3, opts.volume ?? true),
    fieldVarint(4, opts.keyboard ?? false),
    fieldVarint(5, opts.outputDevice ?? false),
  ]);
  return buildProtocolMessage(MrpType.CLIENT_UPDATES_CONFIG_MESSAGE, MrpField.clientUpdatesConfigMessage, inner);
}

// --- SendCommandMessage / CommandInfo.Command (verified enum values). ---

/** `CommandInfo.Command` enum — only the transport-control subset this driver uses;
 * verified against `CommandInfo.proto`. */
export const enum MrpTransportCommand {
  Play = 1,
  Pause = 2,
  TogglePlayPause = 3,
  Stop = 4,
  NextTrack = 5,
  PreviousTrack = 6,
}

export function buildSendCommandMessage(command: MrpTransportCommand): Buffer {
  const inner = fieldVarint(1, command); // SendCommandMessage.command
  return buildProtocolMessage(MrpType.SEND_COMMAND_MESSAGE, MrpField.sendCommandMessage, inner);
}

// --- SendHIDEventMessage (byte-exact layout verified against messages.py's send_hid_event). ---

/** Verified `(usagePage, usage)` pairs for MRP navigation, from pyatv's MRP
 * `RemoteControl._KEY_LOOKUP`. */
export const MRP_HID_KEYS = {
  up: [1, 0x8c],
  down: [1, 0x8d],
  left: [1, 0x8b],
  right: [1, 0x8a],
  select: [1, 0x89],
  menu: [1, 0x86],
  home: [12, 0x40],
} as const satisfies Record<string, readonly [number, number]>;

export type MrpHidKey = keyof typeof MRP_HID_KEYS;

const HID_ABSTIME = Buffer.from("438922cf08020000", "hex");
const HID_MID_CONSTANT = Buffer.from(
  "0000000000000000010000000000000002000000200000000300000001000000000000",
  "hex",
);
const HID_SUFFIX = Buffer.from("0000000000000001000000", "hex");

/** Builds ONE key event (down or up) — callers send a down immediately followed by an
 * up, matching pyatv's `_send_hid_key`. Byte layout verified byte-for-byte against
 * `messages.py`'s `send_hid_event()` (abstime + fixed 35-byte constant + usagePage(2)
 * +usage(2)+down(2) big-endian + 11-byte suffix). */
export function buildSendHidEventMessage(usagePage: number, usage: number, down: boolean): Buffer {
  const data = Buffer.concat([
    u16be(usagePage),
    u16be(usage),
    u16be(down ? 1 : 0),
  ]);
  const hidEventData = Buffer.concat([HID_ABSTIME, HID_MID_CONSTANT, data, HID_SUFFIX]);
  const inner = fieldBytes(1, hidEventData); // SendHIDEventMessage.hidEventData
  return buildProtocolMessage(MrpType.SEND_HID_EVENT_MESSAGE, MrpField.sendHIDEventMessage, inner);
}

function u16be(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

// --- SetStateMessage / NowPlayingInfo (feedback decode; verified field numbers). ---

export const enum MrpPlaybackState {
  Unknown = 0,
  Playing = 1,
  Paused = 2,
  Stopped = 3,
  Interrupted = 4,
  Seeking = 5,
}

export interface MrpNowPlayingInfo {
  album: string | null;
  artist: string | null;
  duration: number | null;
  elapsedTime: number | null;
  title: string | null;
}

export interface MrpSetState {
  playbackState: MrpPlaybackState | null;
  nowPlaying: MrpNowPlayingInfo | null;
  displayName: string | null;
}

/** Reads a proto2 `double` (8-byte little-endian IEEE754) stored as a length-delimited
 * field — proto2 fixed64/double fields use wire type 1 (not covered by our writer, which
 * never emits one), but pyatv's own Python protobuf runtime happily reads either
 * representation a peer sends; since we only ever DECODE doubles here (never encode
 * one), we special-case wire type 1 only inside this decoder. */
function decodeFieldsWithFixed64(buf: Buffer): RawField[] {
  const fields: RawField[] = [];
  let i = 0;
  while (i < buf.length) {
    const { value: key, next } = decodeVarint(buf, i);
    i = next;
    const fieldNumber = key >>> 3;
    const wireType = key & 0x7;
    if (wireType === 0) {
      const { value, next: next2 } = decodeVarint(buf, i);
      i = next2;
      fields.push({ fieldNumber, wireType: 0, value });
    } else if (wireType === 1) {
      if (i + 8 > buf.length) throw new Error("mrp-protobuf: truncated fixed64");
      fields.push({ fieldNumber, wireType: 2, value: buf.subarray(i, i + 8) }); // tag as bytes; caller reads as double
      i += 8;
    } else if (wireType === 2) {
      const { value: len, next: next2 } = decodeVarint(buf, i);
      i = next2;
      if (i + len > buf.length) throw new Error("mrp-protobuf: truncated length-delimited field");
      fields.push({ fieldNumber, wireType: 2, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wireType === 5) {
      if (i + 4 > buf.length) throw new Error("mrp-protobuf: truncated fixed32");
      fields.push({ fieldNumber, wireType: 2, value: buf.subarray(i, i + 4) });
      i += 4;
    } else {
      throw new Error(`mrp-protobuf: unsupported wire type ${wireType} (field ${fieldNumber})`);
    }
  }
  return fields;
}

function fieldMapLoose(buf: Buffer): Map<number, Buffer | number> {
  const m = new Map<number, Buffer | number>();
  for (const f of decodeFieldsWithFixed64(buf)) m.set(f.fieldNumber, f.value);
  return m;
}

function getDouble(m: Map<number, Buffer | number>, fieldNumber: number): number | null {
  const v = m.get(fieldNumber);
  if (!(v instanceof Buffer)) return null;
  if (v.length === 8) return v.readDoubleLE(0);
  if (v.length === 4) return v.readFloatLE(0);
  return null;
}

const NowPlayingField = { album: 1, artist: 2, duration: 3, elapsedTime: 4, title: 9 } as const;
const SetStateField = { nowPlayingInfo: 1, displayName: 5, playbackState: 6 } as const;

/** Parses a `SET_STATE_MESSAGE` `ProtocolMessage` — real decode, no fabricated fields:
 * anything the message doesn't include comes back `null`. */
export function parseSetStateMessage(protocolMessage: Buffer): MrpSetState {
  const top = fieldMapLoose(protocolMessage);
  const setStateBuf = getBytes(top as Map<number, Buffer | number>, MrpField.setStateMessage);
  if (!setStateBuf) return { playbackState: null, nowPlaying: null, displayName: null };
  const setState = fieldMapLoose(setStateBuf);
  const playbackStateRaw = setState.get(SetStateField.playbackState);
  const playbackState = typeof playbackStateRaw === "number" ? (playbackStateRaw as MrpPlaybackState) : null;
  const displayName = getString(setState, SetStateField.displayName);
  const npiBuf = getBytes(setState, SetStateField.nowPlayingInfo);
  const nowPlaying = npiBuf
    ? (() => {
        const npi = fieldMapLoose(npiBuf);
        return {
          album: getString(npi, NowPlayingField.album),
          artist: getString(npi, NowPlayingField.artist),
          duration: getDouble(npi, NowPlayingField.duration),
          elapsedTime: getDouble(npi, NowPlayingField.elapsedTime),
          title: getString(npi, NowPlayingField.title),
        };
      })()
    : null;
  return { playbackState, nowPlaying, displayName };
}

/** True if this decoded `ProtocolMessage`'s `type` field equals the given type. */
export function messageType(protocolMessage: Buffer): number | null {
  const top = fieldMap(protocolMessage);
  return getVarint(top, MrpField.type);
}
