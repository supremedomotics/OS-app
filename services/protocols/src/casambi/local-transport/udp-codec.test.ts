import { describe, expect, it } from "vitest";
import {
  CASAMBI_BUTTON_EVENT,
  CASAMBI_CONTROL_TYPE,
  CASAMBI_NODE_CONDITION,
  CASAMBI_NODE_STATUS_REQUEST,
  CASAMBI_NOTIFY_CONTROL_REQUEST,
  CASAMBI_TARGET_TYPE,
  decodeCasambiPacket,
  decodeFadeUnits,
  encodeCasambiPacket,
  encodeFadeMs,
  encodeGetParameterValue,
  encodeNodeStatusRequest,
  encodeNotifyButtonEvent,
  encodeNotifyControlValuesSetDefaultMask,
  encodeNotifyControlValuesSubscribe,
  encodePushButtonPressed,
  encodeRequestTime,
  encodeSetColorRGBW,
  encodeSetGroupLevel,
  encodeSetSceneLevel,
  encodeSetTargetLevel,
  parseButtonEvent,
  parseNodeRemoved,
  parseNodeStatus,
  parseNotifyControlValues,
  parseParameterResponse,
  parseSceneCalled,
  parseSceneStatus,
  parseTargetColor,
  parseTargetStatus,
  parseTimeReceived,
  type CasambiPacket,
} from "./udp-codec.js";

describe("frame codec (encodeCasambiPacket / decodeCasambiPacket)", () => {
  it("round-trips a documented hex-with-dot example (0x28 Request time)", () => {
    // p.290: "Command 1.40 is to be sent to a Casambi bridge with the Net ID 1" -> "1.72.1.28\r\n"
    const wire = encodeCasambiPacket(encodeRequestTime(1), "hex-dot");
    expect(wire).toBe("1.72.1.28\r\n");
    expect(decodeCasambiPacket(wire, "hex-dot")).toEqual({
      netId: 1,
      direction: "toCasambi",
      opcode: 0x28,
      args: [],
      ack: false,
    });
  });

  it("round-trips the equivalent decimal-with-hash example", () => {
    // p.263: same command -> "1#114#1#40\r\n"
    const wire = encodeCasambiPacket(encodeRequestTime(1), "dec-hash");
    expect(wire).toBe("1#114#1#40\r\n");
    expect(decodeCasambiPacket(wire, "dec-hash").opcode).toBe(40);
  });

  it("matches the documented 0x1E Set-level-of-a-scene example byte-for-byte", () => {
    // p.285: "0.72.5.1e.1.ff.10.0\r\n" — Scene=1, Level=255, Duration_low=0x10 (16 units = 160ms)
    const wire = encodeCasambiPacket(encodeSetSceneLevel(0, 1, 255, 160), "hex-dot");
    expect(wire).toBe("0.72.5.1e.1.ff.10.0\r\n");
  });

  it("encodes 0x2F Set-color-via-RGBW's 7 data bytes correctly (Length computed from the general formula)", () => {
    // p.294's worked example literally reads "0.72.7.2f.ff.0.0.ff.1.1.ff\r\n" — Length token "7"
    // with 7 data bytes after the opcode (R,G,B,W,Type,ID,Level). That contradicts the doc's own
    // universal rule (p.264: "length = opcode + arguments", i.e. 1 + 7 = 8), and the same
    // off-by-one recurs in 0x3D's own worked example — see `encodeSetColorRGBW`'s doc comment.
    // This codec always computes Length from the universal formula, not a per-opcode caption, so
    // it emits "8" here — matching the field data itself, not the doc's likely-typo'd caption.
    const wire = encodeCasambiPacket(
      encodeSetColorRGBW(0, CASAMBI_TARGET_TYPE.device, 1, { r: 255, g: 0, b: 0, w: 255, level: 255 }),
      "hex-dot",
    );
    expect(wire).toBe("0.72.8.2f.ff.0.0.ff.1.1.ff\r\n");
  });

  it("parses the documented ACK suffix", () => {
    // p.264: "0x_Net_ID.0x70.0x_Casambi_Data[1...X].ACK\r\n"
    const decoded = decodeCasambiPacket("0.70.1.28.ACK\r\n", "hex-dot");
    expect(decoded.ack).toBe(true);
    expect(decoded.opcode).toBe(0x28);
  });

  it("rejects an unknown Command_Direction byte", () => {
    expect(() => decodeCasambiPacket("0.99.1.28\r\n", "hex-dot")).toThrow(/Command_Direction/);
  });

  it("rejects a packet shorter than the minimum 4 fields", () => {
    expect(() => decodeCasambiPacket("0.70\r\n", "hex-dot")).toThrow(/Malformed/);
  });

  it("uses the declared Length field to bound args, ignoring stray trailing tokens", () => {
    // Length=1 means "opcode only" — even if more tokens follow, only 0 args are kept.
    const decoded = decodeCasambiPacket("0.70.1.28.99.99\r\n", "hex-dot");
    expect(decoded.args).toEqual([]);
  });
});

describe("fade time helpers", () => {
  it("round-trips 10ms units", () => {
    expect(encodeFadeMs(160)).toEqual([0x10, 0]);
    expect(decodeFadeUnits(0x10, 0)).toBe(160);
  });

  it("round-trips a value spanning both bytes", () => {
    const ms = 6_000; // 600 units = 0x0258
    const [low, high] = encodeFadeMs(ms);
    expect(decodeFadeUnits(low, high)).toBe(ms);
  });
});

describe("commands to Casambi (toCasambi direction)", () => {
  it("encodePushButtonPressed", () => {
    expect(encodePushButtonPressed(0, 2)).toEqual({ netId: 0, direction: "toCasambi", opcode: 0x10, args: [2] });
  });

  it("encodeGetParameterValue takes no args", () => {
    expect(encodeGetParameterValue(0).args).toEqual([]);
  });

  it("encodeSetTargetLevel omits fade args when no fade is given", () => {
    const packet = encodeSetTargetLevel(0, CASAMBI_TARGET_TYPE.device, 5, 200);
    expect(packet.args).toEqual([200, CASAMBI_TARGET_TYPE.device, 5]);
    expect(encodeCasambiPacket(packet, "hex-dot")).toBe("0.72.4.20.c8.1.5\r\n");
  });

  it("encodeSetTargetLevel includes fade args when given", () => {
    const packet = encodeSetTargetLevel(0, CASAMBI_TARGET_TYPE.device, 5, 200, 160);
    expect(packet.args).toEqual([200, 0x10, 0, CASAMBI_TARGET_TYPE.device, 5]);
  });

  it("encodeSetGroupLevel matches the group addressing scheme", () => {
    const packet = encodeSetGroupLevel(0, 7, 128);
    expect(packet).toEqual({ netId: 0, direction: "toCasambi", opcode: 0x1f, args: [7, 128] });
  });

  it("encodeNodeStatusRequest's own-node probe value is the documented 0xFF", () => {
    expect(CASAMBI_NODE_STATUS_REQUEST.ownNode).toBe(0xff);
    expect(encodeNodeStatusRequest(0, CASAMBI_NODE_STATUS_REQUEST.ownNode).args).toEqual([0xff]);
  });

  it("encodeNotifyButtonEvent maps enable/disable to the documented request values", () => {
    expect(encodeNotifyButtonEvent(0, true).args).toEqual([0xfd]);
    expect(encodeNotifyButtonEvent(0, false).args).toEqual([0]);
  });

  it("encodeNotifyControlValuesSetDefaultMask matches the documented fixed mask", () => {
    // p.314: "3.0.0.FF.FF.FF.FF"
    expect(encodeNotifyControlValuesSetDefaultMask(0).args).toEqual([
      CASAMBI_NOTIFY_CONTROL_REQUEST.setDefaultMask,
      0,
      0,
      0xff,
      0xff,
      0xff,
      0xff,
    ]);
  });

  it("encodeNotifyControlValuesSubscribe targets a device ID range", () => {
    expect(encodeNotifyControlValuesSubscribe(0, 0, 250).args).toEqual([CASAMBI_NOTIFY_CONTROL_REQUEST.subscribe, 0, 250]);
  });
});

describe("responses from Casambi (fromCasambi direction)", () => {
  const fromCasambi = (opcode: number, args: number[]): CasambiPacket => ({ netId: 0, direction: "fromCasambi", opcode, args });

  it("parseSceneCalled matches the documented example byte-for-byte", () => {
    // p.266: "0.70.9.d.ff.0.0.0.0.0.0.0d\r\n"
    const decoded = decodeCasambiPacket("0.70.9.d.ff.0.0.0.0.0.0.0d\r\n", "hex-dot");
    expect(parseSceneCalled(decoded).bits).toEqual([255, 0, 0, 0, 0, 0, 0, 13]);
  });

  it("parseTimeReceived matches the documented example byte-for-byte", () => {
    // p.269: "0.70.8.28.7.e4.3.5.e.13.1d\r\n" -> year 2020, month 3, day 5, 14:19:29
    const decoded = decodeCasambiPacket("0.70.8.28.7.e4.3.5.e.13.1d\r\n", "hex-dot");
    expect(parseTimeReceived(decoded)).toEqual({ year: 2020, month: 3, day: 5, hour: 14, minute: 19, second: 29 });
  });

  it("parseTimeReceived agrees between hex-dot and dec-hash encodings of the same example", () => {
    const decoded = decodeCasambiPacket("000#112#008#040#007#228#003#005#014#019#029\r\n", "dec-hash");
    expect(parseTimeReceived(decoded)).toEqual({ year: 2020, month: 3, day: 5, hour: 14, minute: 19, second: 29 });
  });

  it("parseNodeStatus splits Priority_Node_Type into priority and node type", () => {
    // Node type 1 (active node, bits 6-7 = 01) + priority 3 (manual control, bits 0-5) = 0b01_000011 = 0x43
    const decoded = fromCasambi(0x39, [7, 1, 0x43, 0x00, 1]);
    expect(parseNodeStatus(decoded)).toMatchObject({ unitId: 7, scene: 1, priority: 3, nodeType: 1, condition: 0, online: 1 });
    expect(parseNodeStatus(decoded).conditionLabel).toBe("ok");
  });

  it("parseNodeStatus reports a known non-ok condition label", () => {
    const decoded = fromCasambi(0x39, [7, 0, 0, 0x82, 0]);
    expect(parseNodeStatus(decoded).conditionLabel).toBe("lamp_failure");
  });

  it("parseNodeRemoved reads Unit_ID", () => {
    expect(parseNodeRemoved(fromCasambi(0x3a, [2])).unitId).toBe(2);
  });

  it("parseSceneStatus decodes the Active bit and ignores higher bits", () => {
    expect(parseSceneStatus(fromCasambi(0x45, [3, 0b11, 200]))).toEqual({ scene: 3, active: true, level: 200 });
    expect(parseSceneStatus(fromCasambi(0x45, [3, 0, 200])).active).toBe(false);
  });

  it("parseTargetStatus reads all six documented fields in order", () => {
    expect(parseTargetStatus(fromCasambi(0x46, [1, 200, 255, 128, CASAMBI_TARGET_TYPE.device, 50]))).toEqual({
      targetId: 1,
      level: 200,
      lastLevel: 255,
      cctLevel: 128,
      targetType: CASAMBI_TARGET_TYPE.device,
      verticalRatio: 50,
    });
  });

  it("parseTargetColor only sets hue/sat/xy/levelXy when the response actually carries them", () => {
    const minimal = fromCasambi(0x49, [CASAMBI_TARGET_TYPE.device, 1, 200, 255, 0, 0, 255]);
    const result = parseTargetColor(minimal);
    expect(result).toEqual({ targetType: CASAMBI_TARGET_TYPE.device, targetId: 1, level: 200, r: 255, g: 0, b: 0, w: 255 });
    expect(result.hue).toBeUndefined();
  });

  it("parseButtonEvent maps documented event codes to labels", () => {
    expect(parseButtonEvent(fromCasambi(0x51, [9, 1, 0, 2])).eventLabel).toBe("short_press");
    expect(CASAMBI_BUTTON_EVENT[9]).toBe("long_press_start");
    expect(parseButtonEvent(fromCasambi(0x51, [9, 1, 0, 9])).eventLabel).toBe("long_press_start");
    expect(parseButtonEvent(fromCasambi(0x51, [9, 1, 0, 12])).eventLabel).toBe("long_press_end");
    expect(parseButtonEvent(fromCasambi(0x51, [9, 1, 0, 250])).eventLabel).toBeUndefined();
  });
});

describe("0x1A/0x1B SetParameterValue vs ParametersComplete (flagged doc inconsistency)", () => {
  it("disambiguates by Length, not by the doc's self-contradictory opcode field", () => {
    const withData: CasambiPacket = { netId: 0, direction: "fromCasambi", opcode: 0x1b, args: [3, 200] };
    expect(parseParameterResponse(withData)).toEqual({ kind: "parameterValue", parameterNumber: 3, parameterValue: 200 });

    const complete: CasambiPacket = { netId: 0, direction: "fromCasambi", opcode: 0x1b, args: [] };
    expect(parseParameterResponse(complete)).toEqual({ kind: "parametersComplete" });
  });

  it("also accepts the section-heading opcode 0x1A for the same shape", () => {
    const withData: CasambiPacket = { netId: 0, direction: "fromCasambi", opcode: 0x1a, args: [1, 50] };
    expect(parseParameterResponse(withData)).toEqual({ kind: "parameterValue", parameterNumber: 1, parameterValue: 50 });
  });

  it("rejects an unrelated opcode", () => {
    const wrong: CasambiPacket = { netId: 0, direction: "fromCasambi", opcode: 0x39, args: [] };
    expect(() => parseParameterResponse(wrong)).toThrow();
  });
});

describe("0x4B NotifyControlValues", () => {
  const fromCasambi = (args: number[]): CasambiPacket => ({ netId: 0, direction: "fromCasambi", opcode: 0x4b, args });

  it("parses short-form dimmer, presence, and lux entries for one target", () => {
    const decoded = parseNotifyControlValues(
      fromCasambi([
        5, // Target_ID
        1, 200, // TYPE=1 dimmerChannel, VALUE=200
        21, 1, // TYPE=21 presenceSensor, VALUE=1 (active)
        20, 0x2c, 0x01, // TYPE=20 lightSensorLux, 2-byte LE -> 0x012c = 300
      ]),
    );
    expect(decoded.targetId).toBe(5);
    expect(decoded.truncated).toBe(false);
    expect(decoded.values).toEqual([
      { type: 1, typeName: "dimmerChannel", valueBytes: [200] },
      { type: 21, typeName: "presenceSensor", valueBytes: [1] },
      { type: 20, typeName: "lightSensorLux", valueBytes: [0x2c, 0x01] },
    ]);
  });

  it("parses a long-form entry (0x80 bit set) with explicit INDEX/LEN", () => {
    // TYPE=0x81 (dimmer channel, long form) : INDEX=2 : LEN=1 : VALUE=128
    const decoded = parseNotifyControlValues(fromCasambi([5, 0x81, 2, 1, 128]));
    expect(decoded.values).toEqual([{ type: 0x81, typeName: "dimmerChannel", index: 2, valueBytes: [128] }]);
  });

  it("honestly truncates on the ambiguous short-form type 14 rather than guessing a size", () => {
    const decoded = parseNotifyControlValues(fromCasambi([5, 14, 1, 2, 3]));
    expect(decoded.truncated).toBe(true);
    expect(decoded.values).toEqual([]);
  });

  it("empty response carries only the Target_ID (p.315)", () => {
    const decoded = parseNotifyControlValues(fromCasambi([5]));
    expect(decoded.values).toEqual([]);
    expect(decoded.truncated).toBe(false);
  });

  it("CASAMBI_CONTROL_TYPE table matches the documented sizes for common types", () => {
    expect(CASAMBI_CONTROL_TYPE[1]).toEqual({ name: "dimmerChannel", size: 1 });
    expect(CASAMBI_CONTROL_TYPE[3]).toEqual({ name: "hueSaturation", size: 3 });
    expect(CASAMBI_CONTROL_TYPE[4]).toEqual({ name: "xyColor", size: 4 });
    expect(CASAMBI_CONTROL_TYPE[20]).toEqual({ name: "lightSensorLux", size: 2 });
    expect(CASAMBI_CONTROL_TYPE[14].size).toBeNull();
  });
});

describe("target type / node condition constant tables", () => {
  it("CASAMBI_TARGET_TYPE matches the documented addressing scheme", () => {
    expect(CASAMBI_TARGET_TYPE).toEqual({
      broadcast: 0,
      device: 1,
      groupOrUngrouped: 2,
      sceneActiveOnly: 3,
      sceneAll: 4,
      manufacturer: 5,
    });
  });

  it("CASAMBI_NODE_CONDITION covers every documented condition code", () => {
    expect(CASAMBI_NODE_CONDITION[0x00]).toBe("ok");
    expect(CASAMBI_NODE_CONDITION[0x87]).toBe("configuration_failed");
  });
});
