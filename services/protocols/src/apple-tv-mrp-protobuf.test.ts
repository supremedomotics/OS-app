import { describe, it, expect } from "vitest";
import {
  encodeVarint,
  decodeVarint,
  fieldBytes,
  fieldString,
  fieldVarint,
  decodeFields,
  fieldMap,
  buildDeviceInfoMessage,
  buildCryptoPairingMessage,
  extractCryptoPairingData,
  buildSendCommandMessage,
  buildSendHidEventMessage,
  parseSetStateMessage,
  messageType,
  MrpType,
  MrpTransportCommand,
  MRP_HID_KEYS,
  MrpField,
  MrpPlaybackState,
} from "./apple-tv-mrp-protobuf.js";

describe("MRP protobuf wire codec", () => {
  it("round-trips varints, including multi-byte values", () => {
    for (const v of [0, 1, 127, 128, 300, 16384, 2097151, 2097152, 999_999_999]) {
      const encoded = encodeVarint(v);
      const { value, next } = decodeVarint(encoded, 0);
      expect(value).toBe(v);
      expect(next).toBe(encoded.length);
    }
  });

  it("round-trips a string field and a varint field through decodeFields", () => {
    const msg = Buffer.concat([fieldString(2, "hello"), fieldVarint(1, 42)]);
    const fields = decodeFields(msg);
    expect(fields).toEqual([
      { fieldNumber: 2, wireType: 2, value: Buffer.from("hello") },
      { fieldNumber: 1, wireType: 0, value: 42 },
    ]);
  });

  it("last-value-wins in fieldMap for a repeated field number", () => {
    const msg = Buffer.concat([fieldVarint(5, 1), fieldVarint(5, 2)]);
    const m = fieldMap(msg);
    expect(m.get(5)).toBe(2);
  });

  it("throws on a truncated length-delimited field", () => {
    const bad = Buffer.concat([fieldBytes(1, Buffer.from("hi"))]).subarray(0, 3);
    expect(() => decodeFields(bad)).toThrow(/truncated/);
  });

  it("builds a DEVICE_INFO_MESSAGE with the verified type/field numbers", () => {
    const msg = buildDeviceInfoMessage({
      uniqueIdentifier: "AAAA-BBBB",
      name: "SupremeOS Hub",
      systemBuildVersion: "1.0",
      applicationBundleIdentifier: "local.supreme.hub",
      protocolVersion: 1,
    });
    expect(messageType(msg)).toBe(MrpType.DEVICE_INFO_MESSAGE);
    const top = fieldMap(msg);
    const inner = fieldMap(top.get(MrpField.deviceInfoMessage) as Buffer);
    expect(inner.get(1)).toEqual(Buffer.from("AAAA-BBBB")); // uniqueIdentifier
    expect(inner.get(2)).toEqual(Buffer.from("SupremeOS Hub")); // name
    expect(inner.get(19)).toBe(1); // allowsPairing = true
  });

  it("round-trips CRYPTO_PAIRING_MESSAGE's embedded TLV8 pairingData", () => {
    const tlv8 = Buffer.from([0x06, 0x01, 0x01]); // arbitrary opaque payload for this test
    const msg = buildCryptoPairingMessage(tlv8, 2);
    expect(messageType(msg)).toBe(MrpType.CRYPTO_PAIRING_MESSAGE);
    expect(extractCryptoPairingData(msg).equals(tlv8)).toBe(true);
  });

  it("builds a SEND_COMMAND_MESSAGE with the verified CommandInfo.Command enum value", () => {
    const msg = buildSendCommandMessage(MrpTransportCommand.Play);
    expect(messageType(msg)).toBe(MrpType.SEND_COMMAND_MESSAGE);
    const top = fieldMap(msg);
    const inner = fieldMap(top.get(MrpField.sendCommandMessage) as Buffer);
    expect(inner.get(1)).toBe(MrpTransportCommand.Play);
  });

  it("builds a byte-exact SEND_HID_EVENT_MESSAGE matching pyatv's send_hid_event()", () => {
    const [usagePage, usage] = MRP_HID_KEYS.home;
    const msg = buildSendHidEventMessage(usagePage, usage, true);
    expect(messageType(msg)).toBe(MrpType.SEND_HID_EVENT_MESSAGE);
    const top = fieldMap(msg);
    const inner = fieldMap(top.get(MrpField.sendHIDEventMessage) as Buffer);
    const hidEventData = inner.get(1) as Buffer;
    // 8 (abstime) + 35 (fixed constant) + 6 (usagePage/usage/down) + 11 (suffix) = 60 bytes.
    expect(hidEventData.length).toBe(60);
    // usagePage(2) + usage(2) + down(2) big-endian at the verified offset (8+35=43).
    expect(hidEventData.readUInt16BE(43)).toBe(usagePage);
    expect(hidEventData.readUInt16BE(45)).toBe(usage);
    expect(hidEventData.readUInt16BE(47)).toBe(1);
  });

  it("decodes a SET_STATE_MESSAGE's now-playing info and playback state", () => {
    const npi = Buffer.concat([
      fieldString(1, "Some Album"),
      fieldString(2, "Some Artist"),
      fieldString(9, "Some Title"),
    ]);
    const setState = Buffer.concat([fieldBytes(1, npi), fieldVarint(6, MrpPlaybackState.Playing)]);
    const msg = Buffer.concat([fieldVarint(MrpField.type, MrpType.SET_STATE_MESSAGE), fieldBytes(MrpField.setStateMessage, setState)]);
    const parsed = parseSetStateMessage(msg);
    expect(parsed.playbackState).toBe(MrpPlaybackState.Playing);
    expect(parsed.nowPlaying?.album).toBe("Some Album");
    expect(parsed.nowPlaying?.artist).toBe("Some Artist");
    expect(parsed.nowPlaying?.title).toBe("Some Title");
  });

  it("returns nulls (never fabricated values) for fields absent from a SET_STATE_MESSAGE", () => {
    const msg = Buffer.concat([fieldVarint(MrpField.type, MrpType.SET_STATE_MESSAGE)]);
    const parsed = parseSetStateMessage(msg);
    expect(parsed.playbackState).toBeNull();
    expect(parsed.nowPlaying).toBeNull();
    expect(parsed.displayName).toBeNull();
  });
});
