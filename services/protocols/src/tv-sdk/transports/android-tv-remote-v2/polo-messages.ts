/**
 * (§4 Phase 2 — pairing) Encode/decode for polo.proto's `OuterMessage` envelope and its
 * pairing sub-messages, over the separate pairing port (6467) — distinct from the
 * control-channel codec in remote-messages.ts (6466, remotemessage.proto). Field numbers
 * verified directly against the upstream Apache-2.0 reference's `polo.proto`.
 */
import {
  decodeFields,
  encodeBytesField,
  encodeMessageField,
  encodeStringField,
  encodeVarintField,
  firstBytes,
  firstString,
  firstVarint,
} from "./protobuf-wire.js";

// OuterMessage fields.
const FIELD_PROTOCOL_VERSION = 1;
const FIELD_STATUS = 2;
const FIELD_PAIRING_REQUEST = 10;
const FIELD_PAIRING_REQUEST_ACK = 11;
const FIELD_OPTIONS = 20;
const FIELD_CONFIGURATION = 30;
const FIELD_CONFIGURATION_ACK = 31;
const FIELD_SECRET = 40;
const FIELD_SECRET_ACK = 41;

export const STATUS_OK = 200;

// PairingRequest fields.
const PAIRING_REQUEST_SERVICE_NAME = 1;
const PAIRING_REQUEST_CLIENT_NAME = 2;
// Options fields (Options.Encoding nested message: type=1, symbol_length=2).
const OPTIONS_INPUT_ENCODINGS = 1;
const OPTIONS_PREFERRED_ROLE = 3;
const ENCODING_TYPE = 1;
const ENCODING_SYMBOL_LENGTH = 2;
// Configuration fields.
const CONFIGURATION_ENCODING = 1;
const CONFIGURATION_CLIENT_ROLE = 2;
// Secret/SecretAck field.
const SECRET_BYTES = 1;

export const ENCODING_TYPE_HEXADECIMAL = 3;
export const ROLE_TYPE_INPUT = 1;

export function encodePairingRequest(serviceName: string, clientName: string): Buffer {
  const req = Buffer.concat([
    encodeStringField(PAIRING_REQUEST_SERVICE_NAME, serviceName),
    encodeStringField(PAIRING_REQUEST_CLIENT_NAME, clientName),
  ]);
  return wrapOuter(encodeMessageField(FIELD_PAIRING_REQUEST, req));
}

export function encodeOptions(symbolLength: number): Buffer {
  const encoding = Buffer.concat([
    encodeVarintField(ENCODING_TYPE, ENCODING_TYPE_HEXADECIMAL),
    encodeVarintField(ENCODING_SYMBOL_LENGTH, symbolLength),
  ]);
  const options = Buffer.concat([
    encodeMessageField(OPTIONS_INPUT_ENCODINGS, encoding),
    encodeVarintField(OPTIONS_PREFERRED_ROLE, ROLE_TYPE_INPUT),
  ]);
  return wrapOuter(encodeMessageField(FIELD_OPTIONS, options));
}

export function encodeConfiguration(symbolLength: number): Buffer {
  const encoding = Buffer.concat([
    encodeVarintField(ENCODING_TYPE, ENCODING_TYPE_HEXADECIMAL),
    encodeVarintField(ENCODING_SYMBOL_LENGTH, symbolLength),
  ]);
  const config = Buffer.concat([
    encodeMessageField(CONFIGURATION_ENCODING, encoding),
    encodeVarintField(CONFIGURATION_CLIENT_ROLE, ROLE_TYPE_INPUT),
  ]);
  return wrapOuter(encodeMessageField(FIELD_CONFIGURATION, config));
}

/** `Secret { bytes secret = 1; }` wrapped in the OuterMessage envelope. */
export function encodeSecret(secret: Buffer): Buffer {
  return wrapOuter(encodeMessageField(FIELD_SECRET, encodeBytesField(SECRET_BYTES, secret)));
}

/** Protocol constant. Source: tronikos/androidtvremote2 pairing.py `_create_message()`
 * (`msg.protocol_version = 2`) — the reference client always sends 2 at runtime, even
 * though polo.proto's field declares `[default = 1]`; the wire value observed from a
 * real, working client is what an interoperating implementation must match, not the
 * unused schema default. Verified 2026-09-12. */
const PROTOCOL_VERSION = 2;

function wrapOuter(inner: Buffer): Buffer {
  return Buffer.concat([
    encodeVarintField(FIELD_PROTOCOL_VERSION, PROTOCOL_VERSION),
    encodeVarintField(FIELD_STATUS, STATUS_OK),
    inner,
  ]);
}

/** These four "ForTest" encoders build the SERVER-originated (TV-side) replies this
 * client only ever RECEIVES in production — this codec has no reason to send them for
 * real, but the field numbers are the same verified `OuterMessage` fields as everything
 * else in this file, so exposing them lets tests simulate a real TV's pairing responses
 * without a second, parallel, less-scrutinized fake encoder living only in test code. */
export function encodePairingRequestAckForTest(serverName: string): Buffer {
  return wrapOuter(encodeMessageField(FIELD_PAIRING_REQUEST_ACK, encodeStringField(1, serverName)));
}
export function encodeOptionsForTest(): Buffer {
  return wrapOuter(encodeMessageField(FIELD_OPTIONS, Buffer.alloc(0)));
}
export function encodeConfigurationAckForTest(): Buffer {
  return wrapOuter(encodeMessageField(FIELD_CONFIGURATION_ACK, Buffer.alloc(0)));
}
export function encodeSecretAckForTest(secret: Buffer = Buffer.alloc(0)): Buffer {
  return wrapOuter(encodeMessageField(FIELD_SECRET_ACK, encodeBytesField(SECRET_BYTES, secret)));
}

export type DecodedPoloMessage =
  | { type: "pairing-request-ack"; serverName: string | null; status: number }
  | { type: "options"; status: number }
  | { type: "configuration-ack"; status: number }
  | { type: "secret-ack"; secret: Buffer | null; status: number }
  | { type: "status-only"; status: number };

export function decodePoloMessage(buf: Buffer): DecodedPoloMessage {
  const fields = decodeFields(buf);
  const status = firstVarint(fields, FIELD_STATUS) ?? STATUS_OK;
  const ackBytes = firstBytes(fields, FIELD_PAIRING_REQUEST_ACK);
  if (ackBytes) return { type: "pairing-request-ack", serverName: firstString(decodeFields(ackBytes), 1), status };
  if (firstBytes(fields, FIELD_OPTIONS)) return { type: "options", status };
  if (firstBytes(fields, FIELD_CONFIGURATION_ACK)) return { type: "configuration-ack", status };
  const secretAckBytes = firstBytes(fields, FIELD_SECRET_ACK);
  if (secretAckBytes) return { type: "secret-ack", secret: firstBytes(decodeFields(secretAckBytes), SECRET_BYTES), status };
  return { type: "status-only", status };
}
