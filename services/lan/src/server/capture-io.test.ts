import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPcap, loadCaptureJson, saveCaptureJson } from "./capture-io.js";
import { makeCapture } from "./replay-dgram-socket.js";

describe("Packet Capture file I/O", () => {
  it("round-trips a capture through saveCaptureJson/loadCaptureJson byte-for-byte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "casambi-capture-"));
    try {
      const capture = makeCapture(
        "living-room",
        [
          { raw: Buffer.from("c.70.27.4b.1e\r\n", "ascii"), rinfo: { address: "192.168.0.45", port: 10009 }, atMs: 0 },
          { raw: Buffer.from("c.70.4.4b.5.1.c8\r\n", "ascii"), rinfo: { address: "192.168.0.45", port: 10009 }, atMs: 150 },
        ],
        "Real Wireshark-adjacent capture, Living Room fixture",
      );
      const filePath = join(dir, "living-room.json");
      await saveCaptureJson(capture, filePath);
      const loaded = await loadCaptureJson(filePath);
      expect(loaded).toEqual(capture);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a file that isn't a valid PacketCapture rather than silently returning garbage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "casambi-capture-"));
    try {
      const filePath = join(dir, "not-a-capture.json");
      await import("node:fs/promises").then((fs) => fs.writeFile(filePath, JSON.stringify({ foo: "bar" })));
      await expect(loadCaptureJson(filePath)).rejects.toThrow(/not a valid PacketCapture/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exportPcap writes a file with a valid pcap global header magic number", async () => {
    const dir = await mkdtemp(join(tmpdir(), "casambi-capture-"));
    try {
      const capture = makeCapture("kitchen", [
        { raw: Buffer.from("c.70.27.4b.1e\r\n", "ascii"), rinfo: { address: "192.168.0.45", port: 10009 } },
      ]);
      const filePath = join(dir, "kitchen.pcap");
      await exportPcap(capture, filePath, { destinationAddress: "255.255.255.255", destinationPort: 10009 });
      const bytes = await readFile(filePath);
      expect(bytes.readUInt32LE(0)).toBe(0xa1b2c3d4); // real pcap magic number
      // global header (24) + per-packet header (16) + Ethernet(14) + IPv4(20) + UDP(8) + payload
      const payloadLength = Buffer.from("c.70.27.4b.1e\r\n", "ascii").length;
      expect(bytes.length).toBe(24 + 16 + 14 + 20 + 8 + payloadLength);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
