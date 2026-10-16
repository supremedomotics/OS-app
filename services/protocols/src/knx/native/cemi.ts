/**
 * cEMI (Common External Message Interface) codec for the L_Data service (§ Clean-room KNX
 * stack — telegram layer). Written from the published KNX cEMI / Application layer
 * specifications. Pure functions; no I/O.
 *
 * Only the L_Data.req / .con / .ind messages are handled — they are the only ones a
 * link-layer tunnel exchanges for group communication. Anything else is rejected with an
 * explicit {@link KnxCemiError} (`unsupported_message_code`) so callers can count it
 * rather than guess.
 *
 * Group telegrams distinguish three application services (GroupValueRead / Response /
 * Write). A write or response carries either a ≤6-bit value packed into the low bits of the
 * second APDU octet ("short" data — DPT 1/2/3 and friends) or 1..14 following octets.
 * The two are different on the wire and decoded differently; reads carry no data at all.
 */

import { formatGroupAddress, formatIndividualAddress } from "./address.js";

export const CemiMessageCode = {
  L_DATA_REQ: 0x11,
  L_DATA_CON: 0x2e,
  L_DATA_IND: 0x29,
} as const;

export type CemiErrorCode = "too_short" | "unsupported_message_code" | "length_mismatch" | "bad_structure" | "invalid_input";

export class KnxCemiError extends Error {
  constructor(readonly code: CemiErrorCode, message: string) {
    super(message);
    this.name = "KnxCemiError";
  }
}

export type GroupService = "read" | "response" | "write";

/** Payload of a GroupValueWrite/Response. `short`: 6-bit value inside the APCI octet.
 * `bytes`: 1..14 octets after it. A GroupValueRead has no payload (`null`). */
export type GroupData = { kind: "short"; value: number } | { kind: "bytes"; bytes: Buffer };

export type Priority = "system" | "normal" | "urgent" | "low";
const PRIORITY_BITS: Record<Priority, number> = { system: 0, normal: 1, urgent: 2, low: 3 };
const PRIORITY_FROM_BITS: Priority[] = ["system", "normal", "urgent", "low"];

export interface CemiFrame {
  messageCode: number;
  /** Raw 16-bit individual source address. */
  source: number;
  /** Raw 16-bit destination (group or individual — see {@link destinationIsGroup}). */
  destination: number;
  destinationIsGroup: boolean;
  priority: Priority;
  hopCount: number;
  /** ctrl1 bit 0: for L_Data.con, 1 = the frame was NOT transmitted/acknowledged OK. */
  confirmError: boolean;
  /** Raw TPCI/APCI + data octets (`length + 1` bytes), always present. */
  apdu: Buffer;
  /** Parsed group service, or `null` for any other application/transport service. */
  group: { service: GroupService; data: GroupData | null } | null;
}

export function describeCemi(f: CemiFrame): string {
  const dst = f.destinationIsGroup ? formatGroupAddress(f.destination) : formatIndividualAddress(f.destination);
  return `0x${f.messageCode.toString(16)} ${formatIndividualAddress(f.source)} -> ${dst}${f.group ? ` ${f.group.service}` : ""}`;
}

const APCI_GROUP: Record<number, GroupService> = { 0: "read", 1: "response", 2: "write" };
const APCI_BITS: Record<GroupService, number> = { read: 0, response: 1, write: 2 };

export function decodeCemi(buf: Buffer): CemiFrame {
  if (buf.length < 2) throw new KnxCemiError("too_short", "cEMI shorter than message code + additional-info length");
  const messageCode = buf[0]!;
  if (messageCode !== CemiMessageCode.L_DATA_IND && messageCode !== CemiMessageCode.L_DATA_CON && messageCode !== CemiMessageCode.L_DATA_REQ) {
    throw new KnxCemiError("unsupported_message_code", `cEMI message code 0x${messageCode.toString(16).padStart(2, "0")} is not L_Data`);
  }
  const addInfoLen = buf[1]!;
  const base = 2 + addInfoLen;
  // ctrl1, ctrl2, src(2), dst(2), len(1)
  if (buf.length < base + 7) throw new KnxCemiError("too_short", "cEMI truncated before the NPDU length octet");
  const ctrl1 = buf[base]!;
  const ctrl2 = buf[base + 1]!;
  const source = buf.readUInt16BE(base + 2);
  const destination = buf.readUInt16BE(base + 4);
  const npduLen = buf[base + 6]!;
  const apdu = buf.subarray(base + 7);
  if (apdu.length !== npduLen + 1) {
    throw new KnxCemiError("length_mismatch", `cEMI NPDU declares ${npduLen + 1} octets after the length field, found ${apdu.length}`);
  }
  const destinationIsGroup = (ctrl2 & 0x80) !== 0;
  return {
    messageCode,
    source,
    destination,
    destinationIsGroup,
    priority: PRIORITY_FROM_BITS[(ctrl1 >> 2) & 0x03]!,
    hopCount: (ctrl2 >> 4) & 0x07,
    confirmError: (ctrl1 & 0x01) !== 0,
    apdu: Buffer.from(apdu),
    group: destinationIsGroup ? parseGroupApdu(apdu, npduLen) : null,
  };
}

function parseGroupApdu(apdu: Buffer, npduLen: number): CemiFrame["group"] {
  // Control-type TPCI (connect/disconnect/ack/nak) or numbered data never targets a group.
  if (apdu.length < 2 || (apdu[0]! & 0xfc) !== 0) return null;
  const apci4 = ((apdu[0]! & 0x03) << 2) | (apdu[1]! >> 6);
  const service = APCI_GROUP[apci4];
  if (!service) return null;
  if (service === "read") {
    if (npduLen !== 1) throw new KnxCemiError("bad_structure", `GroupValueRead with ${npduLen - 1} data octets`);
    return { service, data: null };
  }
  if (npduLen === 1) return { service, data: { kind: "short", value: apdu[1]! & 0x3f } };
  // Long form: the six data bits of the APCI octet must be zero per the application layer.
  return { service, data: { kind: "bytes", bytes: Buffer.from(apdu.subarray(2)) } };
}

export interface GroupCemiInput {
  messageCode?: number;
  source: number;
  destination: number;
  service: GroupService;
  data?: GroupData | null;
  priority?: Priority;
  hopCount?: number;
  /** L_Data.con only: mark the frame as not transmitted OK. */
  confirmError?: boolean;
}

export function encodeGroupCemi(i: GroupCemiInput): Buffer {
  const messageCode = i.messageCode ?? CemiMessageCode.L_DATA_REQ;
  const hop = i.hopCount ?? 6;
  if (!Number.isInteger(hop) || hop < 0 || hop > 7) throw new KnxCemiError("invalid_input", `hop count ${hop} out of range 0..7`);
  for (const [n, label] of [[i.source, "source"], [i.destination, "destination"]] as const) {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new KnxCemiError("invalid_input", `${label} ${n} is not a 16-bit address`);
  }
  const data = i.data ?? null;
  if (i.service === "read" && data) throw new KnxCemiError("invalid_input", "GroupValueRead cannot carry data");
  if (i.service !== "read" && !data) throw new KnxCemiError("invalid_input", `Group${i.service} requires data`);

  let apdu: Buffer;
  const apci = APCI_BITS[i.service];
  if (!data) {
    apdu = Buffer.from([apci >> 2, (apci & 0x03) << 6]);
  } else if (data.kind === "short") {
    if (!Number.isInteger(data.value) || data.value < 0 || data.value > 0x3f) throw new KnxCemiError("invalid_input", `short value ${data.value} out of range 0..63`);
    apdu = Buffer.from([apci >> 2, ((apci & 0x03) << 6) | data.value]);
  } else {
    if (data.bytes.length < 1 || data.bytes.length > 14) throw new KnxCemiError("invalid_input", `group data of ${data.bytes.length} octets is outside 1..14`);
    apdu = Buffer.concat([Buffer.from([apci >> 2, (apci & 0x03) << 6]), data.bytes]);
  }
  const ctrl1 = 0x80 /* standard frame */ | 0x20 /* do not repeat */ | 0x10 /* broadcast (not system) */
    | (PRIORITY_BITS[i.priority ?? "low"] << 2) | (i.confirmError ? 1 : 0);
  const ctrl2 = 0x80 /* group address */ | (hop << 4);
  const head = Buffer.alloc(9);
  head[0] = messageCode;
  head[1] = 0; // no additional information
  head[2] = ctrl1;
  head[3] = ctrl2;
  head.writeUInt16BE(i.source, 4);
  head.writeUInt16BE(i.destination, 6);
  head[8] = apdu.length - 1;
  return Buffer.concat([head, apdu]);
}
