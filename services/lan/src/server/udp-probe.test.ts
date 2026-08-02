import { describe, expect, it } from "vitest";
import dgram from "node:dgram";
import { UdpProbe } from "./udp-probe.js";
import { fakeDgramSocket } from "./replay-dgram-socket.js";

/**
 * § Runtime Data Path Verification — the probe's whole value is that it reports reception
 * truthfully, so these tests prove BOTH directions against a REAL socket: a real datagram really
 * is recorded, and a probe that receives nothing really does report zero (rather than, say,
 * defaulting to something that would mask the exact failure being investigated).
 */
describe("UdpProbe against a real OS socket", () => {
  it("records a real datagram's bytes, length, and sender — no decoding, nothing lost", async () => {
    const probe = new UdpProbe({ port: 0 });
    await probe.start();
    const port = probe.snapshot().boundPort!;
    expect(port).toBeGreaterThan(0);

    const sender = dgram.createSocket("udp4");
    const payload = Buffer.from("0102ff.aa", "ascii");
    await new Promise<void>((resolve, reject) => sender.send(payload, port, "127.0.0.1", (e) => (e ? reject(e) : resolve())));
    // Give the event loop a turn to deliver the datagram.
    await new Promise((r) => setTimeout(r, 50));
    sender.close();

    const snap = probe.snapshot();
    expect(snap.datagramsReceived).toBe(1);
    expect(snap.recent).toHaveLength(1);
    const dg = snap.recent[0]!;
    expect(dg.length).toBe(payload.length);
    expect(dg.hex).toBe(payload.toString("hex"));
    expect(dg.ascii).toBe("0102ff.aa");
    expect(dg.sourceAddress).toBe("127.0.0.1");
    expect(snap.firstDatagramAt).not.toBeNull();
    await probe.stop();
  });

  it("reports zero honestly when nothing is sent, and says why that number is not conclusive alone", async () => {
    const probe = new UdpProbe({ port: 0 });
    await probe.start();
    const snap = probe.snapshot();
    expect(snap.listening).toBe(true);
    expect(snap.datagramsReceived).toBe(0);
    expect(snap.firstDatagramAt).toBeNull();
    // The honesty requirement: a zero must not read as proof on its own.
    expect(snap.caveats.join(" ")).toMatch(/host-side capture/);
    await probe.stop();
  });

  it("binds a real OS-assigned port and reports the ACTUAL bound address, not the requested one", async () => {
    const probe = new UdpProbe({ port: 0, address: "127.0.0.1" });
    await probe.start();
    const snap = probe.snapshot();
    expect(snap.boundAddress).toBe("127.0.0.1");
    expect(snap.configuredPort).toBe(0);
    expect(snap.boundPort).not.toBe(0); // the OS picked a real one
    await probe.stop();
  });
});

describe("UdpProbe bookkeeping (fake socket)", () => {
  it("keeps the log bounded so a chatty LAN cannot grow it without limit", async () => {
    const fake = fakeDgramSocket();
    const probe = new UdpProbe({ port: 10009 }, () => fake);
    await probe.start();
    for (let i = 0; i < 60; i++) fake.emitMessage(Buffer.from([i]), { address: "192.168.0.45", port: 10009 });
    const snap = probe.snapshot();
    expect(snap.datagramsReceived).toBe(60); // the COUNT is complete…
    expect(snap.recent).toHaveLength(50); // …while the retained log is capped
    expect(snap.recent[snap.recent.length - 1]!.hex).toBe("3b"); // 59, the newest
  });

  it("renders non-printable bytes as '.' without altering the authoritative hex", async () => {
    const fake = fakeDgramSocket();
    const probe = new UdpProbe({ port: 10009 }, () => fake);
    await probe.start();
    fake.emitMessage(Buffer.from([0x00, 0x41, 0xff, 0x42]), { address: "192.168.0.45", port: 10009 });
    const dg = probe.snapshot().recent[0]!;
    expect(dg.ascii).toBe(".A.B");
    expect(dg.hex).toBe("0041ff42"); // the hex keeps every byte the ASCII view had to mask
    expect(dg.length).toBe(4);
  });

  it("surfaces a bind error rather than reporting a silently-not-listening probe as healthy", async () => {
    const fake = fakeDgramSocket();
    fake.bind = () => fake.emitError(new Error("bind EADDRINUSE 0.0.0.0:10009"));
    const probe = new UdpProbe({ port: 10009 }, () => fake);
    await expect(probe.start()).rejects.toThrow(/EADDRINUSE/);
    const snap = probe.snapshot();
    expect(snap.listening).toBe(false);
    expect(snap.lastError).toMatch(/EADDRINUSE/);
    expect(snap.caveats.join(" ")).toMatch(/not listening/);
  });
});
