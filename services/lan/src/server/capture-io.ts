import { readFile, writeFile } from "node:fs/promises";
import { capturedDatagramBuffer, type CapturedDatagram, type PacketCapture } from "./replay-dgram-socket.js";

/**
 * Packet Capture file I/O (§ Packet Replay Framework). JSON is the one canonical, round-trippable
 * format (save/name/export/import/delete all operate on it). PCAP export is one-way and exists
 * only so a saved capture can be opened directly in Wireshark — see `replay-dgram-socket.ts`'s
 * doc comment for why PCAP import is deliberately not implemented.
 */

export async function saveCaptureJson(capture: PacketCapture, filePath: string): Promise<void> {
  await writeFile(filePath, JSON.stringify(capture, null, 2), "utf8");
}

export async function loadCaptureJson(filePath: string): Promise<PacketCapture> {
  const text = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("packets" in parsed) ||
    !Array.isArray((parsed as { packets: unknown }).packets)
  ) {
    throw new Error(`${filePath}: not a valid PacketCapture (missing "packets" array)`);
  }
  return parsed as PacketCapture;
}

function ipv4ToBytes(addr: string): Uint8Array {
  const parts = addr.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // Non-IPv4 (e.g. a hostname) — 0.0.0.0 is an honest "unknown," never a guessed real address.
    return new Uint8Array([0, 0, 0, 0]);
  }
  return new Uint8Array(parts);
}

function ipChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < header.length; i += 2) sum += header.readUInt16BE(i);
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

/** Wraps a raw UDP payload in a synthetic Ethernet + IPv4 + UDP frame so it displays correctly as
 * UDP traffic in Wireshark. MAC addresses are synthetic placeholders (this was never captured at
 * the link layer — only the UDP payload + source rinfo were recorded); IP/UDP header fields use
 * the capture's real recorded source/destination. UDP checksum is left `0` (valid/permitted for
 * IPv4 per RFC 768 — "not computed," never a fabricated value); the IPv4 header checksum IS
 * computed correctly so the frame parses as well-formed IPv4. */
function frameDatagram(d: CapturedDatagram, destinationAddress: string, destinationPort: number): Buffer {
  const payload = capturedDatagramBuffer(d);
  const udpLength = 8 + payload.length;
  const udp = Buffer.alloc(8);
  udp.writeUInt16BE(d.sourcePort, 0);
  udp.writeUInt16BE(destinationPort, 2);
  udp.writeUInt16BE(udpLength, 4);
  udp.writeUInt16BE(0, 6); // checksum: not computed, permitted for IPv4

  const ipTotalLength = 20 + udpLength;
  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0); // version 4, IHL 5 (20 bytes, no options)
  ip.writeUInt8(0, 1); // DSCP/ECN
  ip.writeUInt16BE(ipTotalLength, 2);
  ip.writeUInt16BE(0, 4); // identification
  ip.writeUInt16BE(0, 6); // flags/fragment offset
  ip.writeUInt8(64, 8); // TTL
  ip.writeUInt8(17, 9); // protocol: UDP
  ip.writeUInt16BE(0, 10); // checksum placeholder
  Buffer.from(ipv4ToBytes(d.sourceAddress)).copy(ip, 12);
  Buffer.from(ipv4ToBytes(destinationAddress)).copy(ip, 16);
  ip.writeUInt16BE(ipChecksum(ip), 10);

  const eth = Buffer.alloc(14);
  eth.fill(0xff, 0, 6); // dest MAC — broadcast placeholder (link-layer address was never captured)
  eth.write("020000000001", 6, "hex"); // src MAC — synthetic placeholder
  eth.writeUInt16BE(0x0800, 12); // EtherType: IPv4

  return Buffer.concat([eth, ip, udp, payload]);
}

/** Writes a real, Wireshark-openable `.pcap` file for a capture. `destinationAddress`/
 * `destinationPort` default to the capture's own recorded values when present (added to
 * `CapturedDatagram` at capture time for hardware-sourced captures), otherwise `255.255.255.255`
 * and the datagram's own source port — an honest placeholder, not a guessed real destination. */
export async function exportPcap(
  capture: PacketCapture,
  filePath: string,
  defaults: { destinationAddress?: string; destinationPort?: number } = {},
): Promise<void> {
  const globalHeader = Buffer.alloc(24);
  globalHeader.writeUInt32LE(0xa1b2c3d4, 0); // magic number
  globalHeader.writeUInt16LE(2, 4); // version major
  globalHeader.writeUInt16LE(4, 6); // version minor
  globalHeader.writeInt32LE(0, 8); // thiszone
  globalHeader.writeUInt32LE(0, 12); // sigfigs
  globalHeader.writeUInt32LE(65535, 16); // snaplen
  globalHeader.writeUInt32LE(1, 20); // network: LINKTYPE_ETHERNET

  const chunks: Buffer[] = [globalHeader];
  for (const d of capture.packets) {
    const frame = frameDatagram(d, defaults.destinationAddress ?? "255.255.255.255", defaults.destinationPort ?? d.sourcePort);
    const perPacketHeader = Buffer.alloc(16);
    const totalMs = Date.parse(capture.savedAt) + d.relativeTimeMs;
    perPacketHeader.writeUInt32LE(Math.floor(totalMs / 1000), 0); // ts_sec
    perPacketHeader.writeUInt32LE((totalMs % 1000) * 1000, 4); // ts_usec
    perPacketHeader.writeUInt32LE(frame.length, 8); // incl_len
    perPacketHeader.writeUInt32LE(frame.length, 12); // orig_len
    chunks.push(perPacketHeader, frame);
  }
  await writeFile(filePath, Buffer.concat(chunks));
}
