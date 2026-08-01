import { describe, expect, it } from "vitest";
import { DgramUdpSession } from "./dgram-udp-session.js";
import { capturedDatagramAscii, fakeDgramSocket, makeCapture, replayableDgramSocket } from "./replay-dgram-socket.js";

describe("Packet Replay Framework — replayableDgramSocket", () => {
  it("injectDatagram fires the SAME listener DgramUdpSession registers — no code path differs from a real datagram", async () => {
    const socket = replayableDgramSocket(fakeDgramSocket);
    const session = new DgramUdpSession("s1", () => socket);
    await session.bind({});

    const received: { msg: Buffer; rinfo: { address: string; port: number } }[] = [];
    session.onMessage((msg, rinfo) => received.push({ msg, rinfo }));

    const capture = makeCapture("test", [{ raw: Buffer.from("hello replay", "ascii"), rinfo: { address: "192.168.0.45", port: 10009 } }]);
    socket.injectDatagram(capture.packets[0]!);

    expect(received).toEqual([{ msg: Buffer.from("hello replay", "ascii"), rinfo: { address: "192.168.0.45", port: 10009 } }]);
    expect(session.packetsReceived).toBe(1); // the real DgramUdpSession counter incremented too
  });

  it("replay() plays back multiple packets honoring relativeTimeMs ordering", async () => {
    const socket = replayableDgramSocket(fakeDgramSocket);
    const session = new DgramUdpSession("s1", () => socket);
    await session.bind({});

    const order: string[] = [];
    session.onMessage((msg) => order.push(msg.toString("ascii")));

    const capture = makeCapture("burst", [
      { raw: Buffer.from("first", "ascii"), rinfo: { address: "192.168.0.45", port: 10009 }, atMs: 0 },
      { raw: Buffer.from("second", "ascii"), rinfo: { address: "192.168.0.45", port: 10009 }, atMs: 20 },
      { raw: Buffer.from("third", "ascii"), rinfo: { address: "192.168.0.45", port: 10009 }, atMs: 40 },
    ]);

    await new Promise<void>((resolve) => {
      socket.replay(capture, { speedMultiplier: 20 }); // 20x — completes fast in a test
      setTimeout(resolve, 50);
    });

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("replay({ loop: true }) keeps replaying until stop() is called", async () => {
    const socket = replayableDgramSocket(fakeDgramSocket);
    const session = new DgramUdpSession("s1", () => socket);
    await session.bind({});

    let count = 0;
    session.onMessage(() => (count += 1));
    const capture = makeCapture("loopme", [{ raw: Buffer.from("x", "ascii"), rinfo: { address: "1.2.3.4", port: 1 } }]);

    const handle = socket.replay(capture, { loop: true, speedMultiplier: 1000 });
    await new Promise((r) => setTimeout(r, 30));
    handle.stop();
    const countAtStop = count;
    await new Promise((r) => setTimeout(r, 30));

    expect(countAtStop).toBeGreaterThan(1); // looped more than once
    expect(count).toBe(countAtStop); // stop() actually stopped further replays
  });

  it("capturedDatagramAscii derives ASCII from the canonical hex — never stored redundantly", () => {
    const capture = makeCapture("t", [{ raw: Buffer.from("c.70.27.4b\r\n", "ascii"), rinfo: { address: "192.168.0.45", port: 10009 } }]);
    expect(capturedDatagramAscii(capture.packets[0]!)).toBe("c.70.27.4b\r\n");
  });

  it("a real bind still works through the replay-wrapped socket (real hardware traffic and replay are not mutually exclusive)", async () => {
    const socket = replayableDgramSocket(fakeDgramSocket);
    const session = new DgramUdpSession("s1", () => socket);
    await session.bind({ localPort: 5100 });
    expect(session.localPort).toBe(5100);
  });
});
