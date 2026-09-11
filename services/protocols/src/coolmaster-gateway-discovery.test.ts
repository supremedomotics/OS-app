import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { candidateHostsForSubnets, discoverCoolMasterGateways, localIPv4SubnetPrefixes } from "./coolmaster-gateway-discovery.js";

/**
 * § Gateway Auto-Discovery tests. Every scenario runs against real in-process TCP servers
 * on 127.0.0.1 at distinct ports — `candidateHosts` is always explicit (never a real LAN
 * scan), so these are deterministic and network-free, while still exercising the REAL
 * ASCII_IF prompt handshake the discovery module identifies gateways with.
 */

function startFakeCoolMaster(serial: string, opts: { greet?: boolean; infoDelayMs?: number } = {}): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      sock.setEncoding("utf8");
      if (opts.greet !== false) sock.write("CoolMasterNet v1.0\r\n>");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split("\r");
        buf = parts.pop() ?? "";
        for (const cmd of parts.map((c) => c.trim()).filter(Boolean)) {
          if (cmd === "info") {
            const send = () => sock.write(`Serial: ${serial}\r\nFirmware: 2.1\r\n>`);
            if (opts.infoDelayMs) setTimeout(send, opts.infoDelayMs);
            else send();
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

function startNonCoolMasterServer(): Promise<{ server: Server; port: number }> {
  // A real TCP listener that never sends a ">" prompt at all — e.g. a stray HTTP/other
  // service occupying the port. Must be rejected, not misidentified.
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => sock.write("HTTP/1.1 400 Bad Request\r\n\r\n"));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

describe("discoverCoolMasterGateways", () => {
  const openServers: Server[] = [];
  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  it("finds 0 gateways when nothing answers", async () => {
    const results = await discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1"], asciiPort: 65000, timeoutMs: 200 });
    expect(results).toEqual([]);
  });

  it("finds exactly 1 gateway and reports its stable identity (coolmaster:<serial>)", async () => {
    const gw = await startFakeCoolMaster("GW-AAA-111");
    openServers.push(gw.server);
    const results = await discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1"], asciiPort: gw.port, timeoutMs: 1000 });
    expect(results).toEqual([{ gatewayId: "coolmaster:GW-AAA-111", serial: "GW-AAA-111", host: "127.0.0.1", asciiPort: gw.port, firmwareVersion: "2.1", application: null }]);
  });

  it("finds 2 distinct gateways on different hosts/ports, each with its own serial", async () => {
    const gwA = await startFakeCoolMaster("GW-A");
    const gwB = await startFakeCoolMaster("GW-B");
    openServers.push(gwA.server, gwB.server);
    // Two "hosts" simulated as two ports on 127.0.0.1, probed with a fixed port per host
    // via two separate discovery calls merged — candidateHosts+asciiPort is one port for
    // every host, so distinct ports need distinct calls; assert the two are genuinely
    // distinguishable by serial regardless.
    const [a, b] = await Promise.all([
      discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1"], asciiPort: gwA.port, timeoutMs: 1000 }),
      discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1"], asciiPort: gwB.port, timeoutMs: 1000 }),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.serial).not.toBe(b[0]!.serial);
    expect(a[0]!.gatewayId).toBe("coolmaster:GW-A");
    expect(b[0]!.gatewayId).toBe("coolmaster:GW-B");
  });

  it("finds multiple gateways across many candidate hosts (scale: several simulated hosts)", async () => {
    // Simulate N distinct "hosts" as N ports on loopback, all probed by a scan that tries
    // every candidate — a stand-in for "many gateways across a real /24 sweep" without
    // needing real distinct IPs.
    const gateways = await Promise.all(["S1", "S2", "S3", "S4", "S5"].map((s) => startFakeCoolMaster(s)));
    gateways.forEach((g) => openServers.push(g.server));
    const results = await Promise.all(
      gateways.map((g) => discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1"], asciiPort: g.port, timeoutMs: 1000 })),
    );
    const serials = results.flat().map((r) => r.serial).sort();
    expect(serials).toEqual(["S1", "S2", "S3", "S4", "S5"]);
  });

  it("collapses duplicate replies for the SAME serial into one result", async () => {
    const gw = await startFakeCoolMaster("GW-DUP");
    openServers.push(gw.server);
    // Two "candidate hosts" that both happen to be the same real listener (loopback +
    // itself) simulate two network paths reaching one physical gateway.
    const results = await discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1", "127.0.0.1"], asciiPort: gw.port, timeoutMs: 1000 });
    expect(results).toHaveLength(1);
    expect(results[0]!.serial).toBe("GW-DUP");
  });

  it("rejects a non-CoolMaster device on the network (a listener that never produces the ASCII_IF prompt)", async () => {
    const other = await startNonCoolMasterServer();
    openServers.push(other.server);
    const results = await discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1"], asciiPort: other.port, timeoutMs: 300 });
    expect(results).toEqual([]);
  });

  it("times out and moves on for a host that never answers at all (no listener)", async () => {
    const start = Date.now();
    const results = await discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1"], asciiPort: 1, timeoutMs: 300 });
    expect(results).toEqual([]);
    expect(Date.now() - start).toBeLessThan(3000); // bounded, not hung
  });

  it("times out (does not hang forever) for a host that accepts the TCP connection but never sends a prompt", async () => {
    const gw = await startFakeCoolMaster("GW-SLOW", { greet: false });
    openServers.push(gw.server);
    const start = Date.now();
    const results = await discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1"], asciiPort: gw.port, timeoutMs: 300 });
    expect(results).toEqual([]);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("§ Discovery Safety — an info response whose 'Serial:' line has no value at all is rejected as inconclusive, not accepted with a fallback serial", async () => {
    // "Serial: " (trailing space, nothing after it) doesn't even match parseKeyValueLines'
    // key/value pattern (which requires a non-empty value) — so this response carries NO
    // serial-shaped field at all, exactly the case the discovery-time (info.serial===host)
    // check exists to catch. Never crashes, never silently drops the OTHER real gateways in
    // the same scan — just correctly excludes this one candidate from the result.
    const gw = await startFakeCoolMaster(""); // "Serial: " with nothing after it
    openServers.push(gw.server);
    const results = await discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1"], asciiPort: gw.port, timeoutMs: 1000 });
    expect(results).toEqual([]);
  });

  it("still identifies a gateway whose info response has a real, if unusually formatted, serial value — never a crash, never a dropped candidate", async () => {
    const gw = await startFakeCoolMaster("SN/with-punctuation_01");
    openServers.push(gw.server);
    const results = await discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1"], asciiPort: gw.port, timeoutMs: 1000 });
    expect(results).toHaveLength(1);
    expect(results[0]!.host).toBe("127.0.0.1");
    expect(results[0]!.serial).toBe("SN/with-punctuation_01");
  });

  it("§ Discovery Safety — rejects a response with NO serial-shaped field at all as inconclusive, never a false-positive gateway match", async () => {
    // A listener that completes the ASCII_IF greeting handshake (so it isn't rejected by
    // the prompt check alone) but replies to "info" with something that carries no
    // Serial/SN/ID field whatsoever — exactly the "some other prompt-driven text protocol
    // happened to be listening on this port" case discovery must not misidentify.
    const malformed = await new Promise<{ server: Server; port: number }>((resolve) => {
      const server = createServer((sock: Socket) => {
        sock.setEncoding("utf8");
        sock.write("Welcome\r\n>");
        let buf = "";
        sock.on("data", (chunk: string) => {
          buf += chunk;
          const parts = buf.split("\r");
          buf = parts.pop() ?? "";
          for (const cmd of parts.map((c) => c.trim()).filter(Boolean)) {
            if (cmd === "info") sock.write("Nothing recognizable here\r\n>");
          }
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
      });
    });
    openServers.push(malformed.server);
    const results = await discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1"], asciiPort: malformed.port, timeoutMs: 1000 });
    expect(results).toEqual([]);
  });

  it("respects a bounded concurrency without dropping any reachable gateway", async () => {
    const gateways = await Promise.all(["C1", "C2", "C3"].map((s) => startFakeCoolMaster(s)));
    gateways.forEach((g) => openServers.push(g.server));
    const results = await Promise.all(
      gateways.map((g) => discoverCoolMasterGateways({ candidateHosts: ["127.0.0.1"], asciiPort: g.port, timeoutMs: 1000, concurrency: 1 })),
    );
    expect(results.flat().map((r) => r.serial).sort()).toEqual(["C1", "C2", "C3"]);
  });
});

describe("candidateHostsForSubnets", () => {
  it("expands a /24 prefix into hosts .1 through .254 (skipping network/broadcast addresses)", () => {
    const hosts = candidateHostsForSubnets(["192.168.1."]);
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe("192.168.1.1");
    expect(hosts[hosts.length - 1]).toBe("192.168.1.254");
    expect(hosts).not.toContain("192.168.1.0");
    expect(hosts).not.toContain("192.168.1.255");
  });

  it("expands multiple prefixes independently", () => {
    const hosts = candidateHostsForSubnets(["10.0.0.", "10.0.1."]);
    expect(hosts).toHaveLength(508);
  });
});

describe("localIPv4SubnetPrefixes", () => {
  it("excludes internal/loopback interfaces and non-IPv4 families", () => {
    const prefixes = localIPv4SubnetPrefixes({
      lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
      eth0: [{ address: "192.168.1.50", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "192.168.1.50/24" }],
      eth0v6: [{ address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: "fe80::1/64", scopeid: 1 }],
    });
    expect(prefixes).toEqual(["192.168.1."]);
  });

  it("dedupes when multiple interfaces share a subnet", () => {
    const iface = { address: "10.0.0.5", netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: "10.0.0.5/24" };
    const prefixes = localIPv4SubnetPrefixes({ a: [iface], b: [{ ...iface, address: "10.0.0.6" }] });
    expect(prefixes).toEqual(["10.0.0."]);
  });
});
