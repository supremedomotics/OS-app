/**
 * (§2/§7 Phase 2) Encode/decode for remotemessage.proto's `RemoteMessage` envelope and
 * the sub-messages this transport actually uses. Field numbers below were verified
 * directly against the upstream Apache-2.0 reference's `.proto` source
 * (github.com/tronikos/androidtvremote2, remotemessage.proto) — NOT guessed. This
 * codec deliberately implements only the envelope arms Phase 2 needs (§9 "no media
 * overreach" — voice/IME/audio-device fields are out of scope); an arm this driver
 * doesn't send/expect is simply never encoded, and an unexpected arm in a decoded
 * message is ignored rather than treated as an error (a future firmware sending a field
 * this driver doesn't know about must never crash the connection).
 */
import {
  decodeFields,
  encodeMessageField,
  encodeStringField,
  encodeVarintField,
  firstBytes,
  firstString,
  firstVarint,
  type RawField,
} from "./protobuf-wire.js";
import { REMOTE_DIRECTION_SHORT } from "./remote-key-codes.js";

// RemoteMessage envelope field numbers (verified).
const FIELD_REMOTE_CONFIGURE = 1;
const FIELD_REMOTE_SET_ACTIVE = 2;
const FIELD_REMOTE_PING_REQUEST = 8;
const FIELD_REMOTE_PING_RESPONSE = 9;
const FIELD_REMOTE_KEY_INJECT = 10;

// RemoteConfigure fields.
const CONFIGURE_CODE1 = 1;
const CONFIGURE_DEVICE_INFO = 2;
// RemoteDeviceInfo fields.
const DEVICE_INFO_MODEL = 1;
const DEVICE_INFO_VENDOR = 2;
const DEVICE_INFO_PACKAGE_NAME = 5;
const DEVICE_INFO_APP_VERSION = 6;
// RemoteSetActive field.
const SET_ACTIVE_ACTIVE = 1;
// RemotePingRequest/Response fields.
const PING_REQUEST_VAL1 = 1;
const PING_REQUEST_VAL2 = 2;
const PING_RESPONSE_VAL1 = 1;
// RemoteKeyInject fields.
const KEY_INJECT_KEY_CODE = 1;
const KEY_INJECT_DIRECTION = 2;

export interface RemoteDeviceInfo {
  model: string;
  vendor: string;
  packageName: string;
  appVersion: string;
}

/**
 * `RemoteConfigure.code1` — VERIFIED 2026-09-12 by direct inspection of the upstream
 * reference client's `remote.py` (`class Feature(IntFlag)`), not guessed. It's a
 * bitmask of protocol features, one bit per capability:
 *
 *   PING = 1<<0, KEY = 1<<1, IME = 1<<2, VOICE = 1<<3, UNKNOWN_1 = 1<<4,
 *   POWER = 1<<5, VOLUME = 1<<6, APP_LINK = 1<<9
 *
 * (bits 7/8/10+ are unassigned in the reference client — never set them). The client's
 * reply is `ownSupportedFeatures & receivedCode1` (upstream: `self._active_features &=
 * supported_features`), i.e. the intersection of what this driver actually implements
 * and what the TV just advertised — NOT an unmodified echo of the TV's value. Echoing
 * would overclaim: if a TV advertises IME/VOICE/APP_LINK, blindly echoing those bits
 * back would tell it this driver handles them, when Phase 2 implements only PING/KEY/
 * POWER/VOLUME (§9 "no media overreach" — IME, VOICE and app-link launching are out of
 * scope; see remotemessage.proto's corresponding message types, none of which this
 * codec encodes).
 */
export const enum RemoteFeature {
  PING = 1 << 0,
  KEY = 1 << 1,
  IME = 1 << 2,
  VOICE = 1 << 3,
  UNKNOWN_1 = 1 << 4,
  POWER = 1 << 5,
  VOLUME = 1 << 6,
  APP_LINK = 1 << 9,
}

/** This transport's actual, implemented feature set — kept in lockstep with what
 * onControlMessage/sendKey really do, not aspirationally widened. */
export const SUPPORTED_FEATURES = RemoteFeature.PING | RemoteFeature.KEY | RemoteFeature.POWER | RemoteFeature.VOLUME;

/**
 * The client's own `RemoteConfigure` reply, sent once after the TV sends its initial
 * `RemoteConfigure` (the TV configures first — see android-tv-remote-v2-transport.ts's
 * connection lifecycle). `code1` is the intersection of `SUPPORTED_FEATURES` and
 * whatever the TV just advertised — see `RemoteFeature`'s doc comment above for why an
 * unmodified echo is protocol-incorrect.
 */
export function encodeRemoteConfigure(receivedCode1: number, deviceInfo: RemoteDeviceInfo): Buffer {
  const info = Buffer.concat([
    encodeStringField(DEVICE_INFO_MODEL, deviceInfo.model),
    encodeStringField(DEVICE_INFO_VENDOR, deviceInfo.vendor),
    encodeStringField(DEVICE_INFO_PACKAGE_NAME, deviceInfo.packageName),
    encodeStringField(DEVICE_INFO_APP_VERSION, deviceInfo.appVersion),
  ]);
  const configure = Buffer.concat([
    encodeVarintField(CONFIGURE_CODE1, SUPPORTED_FEATURES & receivedCode1),
    encodeMessageField(CONFIGURE_DEVICE_INFO, info),
  ]);
  return encodeMessageField(FIELD_REMOTE_CONFIGURE, configure);
}

export function encodeRemoteSetActive(active: number): Buffer {
  return encodeMessageField(FIELD_REMOTE_SET_ACTIVE, encodeVarintField(SET_ACTIVE_ACTIVE, active));
}

export function encodeRemotePingResponse(val1: number): Buffer {
  return encodeMessageField(FIELD_REMOTE_PING_RESPONSE, encodeVarintField(PING_RESPONSE_VAL1, val1));
}

/** Encodes a `RemotePingRequest` — real TVs send these unsolicited to check the client
 * is alive; this driver only ever RECEIVES one in production (see
 * android-tv-remote-v2-transport.ts's ping-response handling), but exposing the encoder
 * is legitimate (the field numbers are verified, same as every other message here) and
 * lets tests simulate a real TV's behavior without a second, parallel fake encoder. */
export function encodeRemotePingRequestForTest(val1: number, val2: number): Buffer {
  const req = Buffer.concat([encodeVarintField(PING_REQUEST_VAL1, val1), encodeVarintField(PING_REQUEST_VAL2, val2)]);
  return encodeMessageField(FIELD_REMOTE_PING_REQUEST, req);
}

export function encodeRemoteKeyInject(keyCode: number): Buffer {
  const inject = Buffer.concat([
    encodeVarintField(KEY_INJECT_KEY_CODE, keyCode),
    encodeVarintField(KEY_INJECT_DIRECTION, REMOTE_DIRECTION_SHORT),
  ]);
  return encodeMessageField(FIELD_REMOTE_KEY_INJECT, inject);
}

export type DecodedRemoteMessage =
  | { type: "remote-configure"; code1: number | null; deviceInfo: RemoteDeviceInfo | null }
  | { type: "remote-set-active"; active: number }
  | { type: "remote-ping-request"; val1: number | null; val2: number | null }
  | { type: "remote-ping-response"; val1: number | null }
  | { type: "remote-key-inject"; keyCode: number | null; direction: number | null }
  | { type: "unknown"; fields: RawField[] };

export function decodeRemoteMessage(buf: Buffer): DecodedRemoteMessage {
  const fields = decodeFields(buf);
  const configureBytes = firstBytes(fields, FIELD_REMOTE_CONFIGURE);
  if (configureBytes) {
    const cfgFields = decodeFields(configureBytes);
    const code1 = firstVarint(cfgFields, CONFIGURE_CODE1);
    const infoBytes = firstBytes(cfgFields, CONFIGURE_DEVICE_INFO);
    const deviceInfo = infoBytes
      ? {
          model: firstString(decodeFields(infoBytes), DEVICE_INFO_MODEL) ?? "",
          vendor: firstString(decodeFields(infoBytes), DEVICE_INFO_VENDOR) ?? "",
          packageName: firstString(decodeFields(infoBytes), DEVICE_INFO_PACKAGE_NAME) ?? "",
          appVersion: firstString(decodeFields(infoBytes), DEVICE_INFO_APP_VERSION) ?? "",
        }
      : null;
    return { type: "remote-configure", code1, deviceInfo };
  }
  const setActiveBytes = firstBytes(fields, FIELD_REMOTE_SET_ACTIVE);
  if (setActiveBytes) {
    return { type: "remote-set-active", active: firstVarint(decodeFields(setActiveBytes), SET_ACTIVE_ACTIVE) ?? 0 };
  }
  const pingReqBytes = firstBytes(fields, FIELD_REMOTE_PING_REQUEST);
  if (pingReqBytes) {
    const f = decodeFields(pingReqBytes);
    return { type: "remote-ping-request", val1: firstVarint(f, PING_REQUEST_VAL1), val2: firstVarint(f, PING_REQUEST_VAL2) };
  }
  const pingResBytes = firstBytes(fields, FIELD_REMOTE_PING_RESPONSE);
  if (pingResBytes) {
    return { type: "remote-ping-response", val1: firstVarint(decodeFields(pingResBytes), PING_RESPONSE_VAL1) };
  }
  const keyInjectBytes = firstBytes(fields, FIELD_REMOTE_KEY_INJECT);
  if (keyInjectBytes) {
    const f = decodeFields(keyInjectBytes);
    return { type: "remote-key-inject", keyCode: firstVarint(f, KEY_INJECT_KEY_CODE), direction: firstVarint(f, KEY_INJECT_DIRECTION) };
  }
  return { type: "unknown", fields };
}
