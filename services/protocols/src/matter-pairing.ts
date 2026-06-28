/**
 * Matter onboarding-payload (setup code) parsing — the input to commissioning a Matter device
 * (Matter Core spec §5.1). A device's label/QR carries either an 11- or 21-digit MANUAL pairing
 * code or an `MT:`-prefixed QR payload; both encode the discriminator + passcode (and the QR also
 * the vendor/product id, discovery capabilities, and commissioning flow) the controller needs to
 * open a PASE session and onboard the node.
 *
 * Pure, dependency-free, spec-accurate decoding — this is exactly what the commissioning UI uses to
 * validate a code before handing it to the (hardware) controller, and is unit-testable to the
 * canonical chip-tool vector (discriminator 3840, passcode 20202021).
 */

export interface MatterOnboardingPayload {
  /** Full 12-bit discriminator (QR), or the 4-bit short discriminator << 8 (manual code). */
  discriminator: number;
  /** True when only the 4-bit short discriminator is known (manual code). */
  shortDiscriminator: boolean;
  /** 27-bit setup passcode (PIN). */
  passcode: number;
  vendorId?: number;
  productId?: number;
  /** Commissioning flow: 0 = standard, 1 = user-intent, 2 = custom (QR only). */
  customFlow?: number;
  /** Discovery capabilities bitmask: bit0 SoftAP, bit1 BLE, bit2 on-network (QR only). */
  discoveryCapabilities?: number;
  source: "manual" | "qr";
}

export class MatterPairingError extends Error {}

// Passcodes the spec forbids (trivial/sequential). Commissioning must reject these.
const INVALID_PASSCODES = new Set([
  0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999,
  12345678, 87654321,
]);

/** Parse either a manual pairing code or an `MT:` QR payload (whitespace/dashes ignored). */
export function parseMatterSetupCode(input: string): MatterOnboardingPayload {
  const trimmed = input.trim();
  if (trimmed.toUpperCase().startsWith("MT:")) return parseQrPayload(trimmed);
  return parseManualPairingCode(trimmed);
}

// ── Manual pairing code ────────────────────────────────────────────────────────────────────────
/**
 * Decode an 11-digit (short) or 21-digit (with vendor/product) manual pairing code. Layout
 * (spec §5.1.4.1): digit0 = vidPidFlag + top 2 bits of the 4-bit short discriminator; digits 1–5
 * = low 2 discriminator bits + low 14 passcode bits; digits 6–9 = high 13 passcode bits; then the
 * optional 5-digit VID + 5-digit PID; the final digit is a Verhoeff check digit.
 */
export function parseManualPairingCode(input: string): MatterOnboardingPayload {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) throw new MatterPairingError("manual pairing code must be digits");
  if (digits.length !== 11 && digits.length !== 21) {
    throw new MatterPairingError(`manual pairing code must be 11 or 21 digits (got ${digits.length})`);
  }
  if (!verhoeffValidate(digits)) throw new MatterPairingError("manual pairing code check digit failed");

  const chunk1 = Number(digits.slice(0, 1));
  const chunk2 = Number(digits.slice(1, 6));
  const chunk3 = Number(digits.slice(6, 10));
  const hasVidPid = (chunk1 & 0x04) !== 0;
  if (hasVidPid !== (digits.length === 21)) {
    throw new MatterPairingError("manual pairing code length disagrees with its VID/PID flag");
  }

  const shortDisc = ((chunk1 & 0x03) << 2) | ((chunk2 >> 14) & 0x03); // 4-bit short discriminator
  const passcode = (chunk2 & 0x3fff) | ((chunk3 & 0x1fff) << 14); // 27-bit passcode
  assertPasscode(passcode);

  const payload: MatterOnboardingPayload = {
    discriminator: shortDisc << 8, // place the 4 known bits where they belong in the 12-bit value
    shortDiscriminator: true,
    passcode,
    source: "manual",
  };
  if (hasVidPid) {
    payload.vendorId = Number(digits.slice(10, 15));
    payload.productId = Number(digits.slice(15, 20));
  }
  return payload;
}

// ── QR payload (MT:…) ────────────────────────────────────────────────────────────────────────
const BASE38 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.";

/** Decode an `MT:`-prefixed QR onboarding payload (spec §5.1.3): base-38 → packed bit fields. */
export function parseQrPayload(input: string): MatterOnboardingPayload {
  const body = input.slice(3); // drop "MT:"
  const bytes = base38Decode(body);
  const reader = new BitReader(bytes);
  const version = reader.read(3);
  if (version !== 0) throw new MatterPairingError(`unsupported QR payload version ${version}`);
  const vendorId = reader.read(16);
  const productId = reader.read(16);
  const customFlow = reader.read(2);
  const discoveryCapabilities = reader.read(8);
  const discriminator = reader.read(12);
  const passcode = reader.read(27);
  assertPasscode(passcode);
  return { discriminator, shortDiscriminator: false, passcode, vendorId, productId, customFlow, discoveryCapabilities, source: "qr" };
}

function base38Decode(s: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 5) {
    const chunk = s.slice(i, i + 5);
    let value = 0;
    for (let j = chunk.length - 1; j >= 0; j--) {
      const d = BASE38.indexOf(chunk[j]!.toUpperCase());
      if (d < 0) throw new MatterPairingError(`invalid base-38 character '${chunk[j]}'`);
      value = value * 38 + d;
    }
    // 5 chars → 3 bytes, 4 chars → 2 bytes, 2 chars → 1 byte (spec §5.1.3.2).
    const n = chunk.length === 5 ? 3 : chunk.length === 4 ? 2 : chunk.length === 2 ? 1 : -1;
    if (n < 0) throw new MatterPairingError(`invalid base-38 chunk length ${chunk.length}`);
    for (let b = 0; b < n; b++) bytes.push((value >> (8 * b)) & 0xff);
  }
  return bytes;
}

/** Reads little-endian bit fields from a byte array (bit 0 of byte 0 first), as the QR packs them. */
class BitReader {
  private bit = 0;
  constructor(private readonly bytes: number[]) {}
  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byteIndex = this.bit >> 3;
      const bitIndex = this.bit & 7;
      const bit = byteIndex < this.bytes.length ? (this.bytes[byteIndex]! >> bitIndex) & 1 : 0;
      value |= bit << i;
      this.bit++;
    }
    return value >>> 0;
  }
}

function assertPasscode(passcode: number): void {
  if (INVALID_PASSCODES.has(passcode)) throw new MatterPairingError("setup passcode is a forbidden trivial value");
  if (passcode < 1 || passcode > 0x7fffffff) throw new MatterPairingError("setup passcode out of range");
}

// ── Verhoeff checksum (Matter manual code check digit) ─────────────────────────────────────────
const D_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Validate a decimal string whose last digit is a Verhoeff check digit. */
function verhoeffValidate(numStr: string): boolean {
  let c = 0;
  const reversed = numStr.split("").reverse().map(Number);
  for (let i = 0; i < reversed.length; i++) {
    c = D_TABLE[c]![P_TABLE[i % 8]![reversed[i]!]!]!;
  }
  return c === 0;
}
