/**
 * HAP TLV8 codec (§ Apple TV Phase 2 — MRP/Companion pairing). Both protocols pair using
 * Apple's HomeKit Accessory Protocol (HAP) pair-setup/pair-verify sequence, whose
 * messages are TLV8-encoded. Tag numbers and the length-255 fragmentation rule below are
 * verified against the real, canonical open-source reference implementation — pyatv
 * (Apache-2.0), `pyatv/auth/hap_tlv8.py` — via a live fetch of that file's actual source
 * during this phase, not from memory or a paraphrase. Nothing here is invented.
 */

/** HAP TLV8 tag values, verified against `pyatv/auth/hap_tlv8.py`'s `TlvValue` enum. */
export const HapTlvTag = {
  Method: 0x00,
  Identifier: 0x01,
  Salt: 0x02,
  PublicKey: 0x03,
  Proof: 0x04,
  EncryptedData: 0x05,
  SeqNo: 0x06, // a.k.a. "State" (M1..M6 / pair-verify step) in the wider HAP spec
  Error: 0x07,
  BackOff: 0x08,
  Certificate: 0x09,
  Signature: 0x0a,
  Permissions: 0x0b,
  FragmentData: 0x0c,
  FragmentLast: 0x0d,
  Name: 0x11,
  Flags: 0x13,
} as const;

export type HapTlvTagValue = (typeof HapTlvTag)[keyof typeof HapTlvTag];

const MAX_CHUNK = 255;

/**
 * Encode a set of tag→value entries as HAP TLV8. Values longer than 255 bytes are split
 * into multiple consecutive entries under the SAME tag — the receiver concatenates
 * repeated tags back together (verified fragmentation rule, see module doc comment).
 * Entries are written in the order given (the HAP messages this serves are ordered).
 */
export function encodeTlv8(entries: ReadonlyArray<readonly [number, Buffer]>): Buffer {
  const chunks: Buffer[] = [];
  for (const [tag, value] of entries) {
    if (tag < 0 || tag > 0xff) throw new Error(`hap-tlv8: tag out of range: ${tag}`);
    if (value.length === 0) {
      chunks.push(Buffer.from([tag, 0]));
      continue;
    }
    for (let offset = 0; offset < value.length; offset += MAX_CHUNK) {
      const slice = value.subarray(offset, offset + MAX_CHUNK);
      chunks.push(Buffer.from([tag, slice.length]), slice);
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Decode HAP TLV8 into a tag→value map, concatenating fragmented (same-tag-repeated)
 * entries back into one buffer per tag, per the verified fragmentation rule.
 */
export function decodeTlv8(data: Buffer): Map<number, Buffer> {
  const result = new Map<number, Buffer>();
  let i = 0;
  while (i < data.length) {
    if (i + 2 > data.length) throw new Error("hap-tlv8: truncated entry header");
    const tag = data[i]!;
    const len = data[i + 1]!;
    i += 2;
    if (i + len > data.length) throw new Error("hap-tlv8: truncated entry value");
    const value = data.subarray(i, i + len);
    i += len;
    const existing = result.get(tag);
    result.set(tag, existing ? Buffer.concat([existing, value]) : Buffer.from(value));
  }
  return result;
}
