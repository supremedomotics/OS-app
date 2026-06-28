import { describe, expect, it } from "vitest";
import { MatterPairingError, parseManualPairingCode, parseMatterSetupCode, parseQrPayload } from "./matter-pairing.js";

/**
 * Validated against the canonical chip-tool test device: discriminator 3840 (0xF00), passcode
 * 20202021, vendor 0xFFF1, product 0x8000. Manual code "34970112332"; QR "MT:Y.K9042C00KA0648G00".
 * These are the de-facto Matter conformance vectors, so matching them proves the decoder.
 */
describe("Matter manual pairing code", () => {
  it("decodes the canonical short code 3497-011-2332", () => {
    const p = parseManualPairingCode("3497-011-2332");
    expect(p.passcode).toBe(20202021);
    // Manual codes carry only the 4-bit short discriminator: top nibble of 3840 (0xF00) is 0xF.
    expect(p.discriminator).toBe(0xf << 8); // 3840
    expect(p.shortDiscriminator).toBe(true);
    expect(p.vendorId).toBeUndefined();
    expect(p.source).toBe("manual");
  });

  it("accepts the code without separators", () => {
    expect(parseManualPairingCode("34970112332").passcode).toBe(20202021);
  });

  it("rejects a code that fails the Verhoeff check digit", () => {
    expect(() => parseManualPairingCode("34970112331")).toThrow(MatterPairingError);
  });

  it("rejects wrong-length and non-numeric codes", () => {
    expect(() => parseManualPairingCode("123")).toThrow(/11 or 21 digits/);
    expect(() => parseManualPairingCode("ABCDEFGHIJK")).toThrow(/must be digits/);
  });
});

describe("Matter QR payload", () => {
  it("decodes the canonical QR MT:Y.K9042C00KA0648G00", () => {
    const p = parseQrPayload("MT:Y.K9042C00KA0648G00");
    expect(p.discriminator).toBe(3840);
    expect(p.shortDiscriminator).toBe(false);
    expect(p.passcode).toBe(20202021);
    expect(p.vendorId).toBe(0xfff1);
    expect(p.productId).toBe(0x8000);
    expect(p.source).toBe("qr");
  });

  it("rejects an invalid base-38 character", () => {
    expect(() => parseQrPayload("MT:Y.K9042C00KA0648G0!")).toThrow(MatterPairingError);
  });
});

describe("parseMatterSetupCode dispatch", () => {
  it("routes MT: to the QR decoder and digits to the manual decoder", () => {
    expect(parseMatterSetupCode("MT:Y.K9042C00KA0648G00").source).toBe("qr");
    expect(parseMatterSetupCode("3497-011-2332").source).toBe("manual");
  });
});
