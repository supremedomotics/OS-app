import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decryptAesEntry, KnxDecryptError, type AesStrength } from "./knx-crypto.js";
import { runKnxImport, unzipKnxproj } from "./knx/index.js";

/**
 * Independent WinZip-AES *encryptor* (mirrors knx-crypto's decryptor) so we can round-trip
 * an encrypted `.knxproj` in-test without shipping ETS sample files. CTR is symmetric, so
 * the keystream code is identical; only the verifier/MAC are appended rather than checked.
 */
const STRENGTH = {
  1: { keyBytes: 16, saltBytes: 8, cipher: "aes-128-ecb" },
  2: { keyBytes: 24, saltBytes: 12, cipher: "aes-192-ecb" },
  3: { keyBytes: 32, saltBytes: 16, cipher: "aes-256-ecb" },
} as const;

function aesCtrLe(key: Buffer, cipher: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  const block = Buffer.alloc(16);
  let value = 1n;
  for (let i = 0; i < data.length; i += 16) {
    block.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
    block.writeBigUInt64LE((value >> 64n) & 0xffffffffffffffffn, 8);
    const ecb = createCipheriv(cipher, key, null);
    ecb.setAutoPadding(false);
    const ks = Buffer.concat([ecb.update(block), ecb.final()]);
    const end = Math.min(i + 16, data.length);
    for (let j = i; j < end; j++) out[j] = data[j]! ^ ks[j - i]!;
    value += 1n;
  }
  return out;
}

function encryptAesEntry(plain: Buffer, strength: AesStrength, password: string): Buffer {
  const s = STRENGTH[strength];
  const salt = randomBytes(s.saltBytes);
  const derived = pbkdf2Sync(Buffer.from(password, "utf8"), salt, 1000, s.keyBytes * 2 + 2, "sha1");
  const encKey = derived.subarray(0, s.keyBytes);
  const authKey = derived.subarray(s.keyBytes, s.keyBytes * 2);
  const verifier = derived.subarray(s.keyBytes * 2);
  const ct = aesCtrLe(encKey, s.cipher, plain);
  const mac = createHmac("sha1", authKey).update(ct).digest().subarray(0, 10);
  return Buffer.concat([salt, verifier, ct, mac]);
}

/** A 0x9901 WinZip-AES extra field describing strength + the real (post-decrypt) method. */
function aesExtraField(strength: AesStrength, realMethod: number): Buffer {
  const b = Buffer.alloc(11);
  b.writeUInt16LE(0x9901, 0);
  b.writeUInt16LE(7, 2);
  b.writeUInt16LE(2, 4); // vendor version AE-2
  b.write("AE", 6, "ascii");
  b.writeUInt8(strength, 8);
  b.writeUInt16LE(realMethod, 9);
  return b;
}

interface Entry { name: string; data: string | Buffer; encrypt?: { strength: AesStrength; password: string } }

/** Minimal ZIP writer that can emit plain (deflate) and WinZip-AES (method 99) entries. */
function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const uncompSize = raw.length;
    const deflated = deflateRawSync(raw);
    let method = 8;
    let body = deflated;
    let extra = Buffer.alloc(0);
    if (e.encrypt) {
      method = 99;
      body = encryptAesEntry(deflated, e.encrypt.strength, e.encrypt.password);
      extra = aesExtraField(e.encrypt.strength, 8);
    }

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(uncompSize, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(extra.length, 28);
    locals.push(lh, name, extra, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(uncompSize, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, name, extra);
    offset += lh.length + name.length + extra.length + body.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, cdBuf, eocd]);
}

const PROJECT_XML = `<?xml version="1.0"?>
<KNX>
  <GroupAddresses>
    <GroupAddress Id="GA-1" Address="2305" Name="Ceiling Switch" DatapointType="DPST-1-1" />
    <GroupAddress Id="GA-2" Address="2306" Name="Ceiling Dim" DatapointType="DPST-5-1" />
  </GroupAddresses>
  <Locations>
    <Space Type="Room" Name="Living Room">
      <Function Type="FT-0" Name="Ceiling Light">
        <GroupAddressRef RefId="GA-1" />
        <GroupAddressRef RefId="GA-2" />
      </Function>
    </Space>
  </Locations>
</KNX>`;

describe("encrypted .knxproj (WinZip-AES)", () => {
  it("round-trips a single AES entry at every strength", () => {
    for (const strength of [1, 2, 3] as AesStrength[]) {
      const plain = Buffer.from("the quick brown fox jumps over thirteen lazy dogs — twice over", "utf8");
      const body = encryptAesEntry(plain, strength, "hunter2");
      expect(decryptAesEntry(body, strength, "hunter2").equals(plain)).toBe(true);
    }
  });

  it("rejects a wrong password before attempting to decrypt", () => {
    const body = encryptAesEntry(Buffer.from("secret"), 3, "correct horse");
    expect(() => decryptAesEntry(body, 3, "battery staple")).toThrow(KnxDecryptError);
  });

  it("unzips and parses a password-protected project (AES-256)", () => {
    const zip = makeZip([{ name: "P-00AB/0.xml", data: PROJECT_XML, encrypt: { strength: 3, password: "villa-2026" } }]);
    const { devices } = runKnxImport({ kind: "knxproj", files: unzipKnxproj(zip, "villa-2026") });
    const ceiling = devices.find((d) => d.name === "Ceiling Light");
    expect(ceiling?.room).toBe("Living Room");
    expect(new Set(ceiling?.bindings.map((b) => b.capability))).toEqual(new Set(["onoff", "brightness"]));
  });

  it("throws a password-required error when the project is locked and no password is given", () => {
    const zip = makeZip([{ name: "0.xml", data: PROJECT_XML, encrypt: { strength: 1, password: "x" } }]);
    expect(() => unzipKnxproj(zip)).toThrow(/password/i);
  });

  it("recurses into a nested encrypted zip", () => {
    const inner = makeZip([{ name: "0.xml", data: PROJECT_XML }]);
    // Wrap the inner zip (as raw bytes) inside an encrypted outer entry.
    const outer = makeZip([{ name: "P-00AB.zip", data: inner, encrypt: { strength: 2, password: "pw" } }]);
    const { devices } = runKnxImport({ kind: "knxproj", files: unzipKnxproj(outer, "pw") });
    expect(devices.find((d) => d.name === "Ceiling Light")?.room).toBe("Living Room");
  });
});
