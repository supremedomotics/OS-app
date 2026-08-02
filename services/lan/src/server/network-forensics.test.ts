import { describe, expect, it } from "vitest";
import { collectNetworkForensics, findKernelSocket, parseKernelHexAddress, parseProcNetRoute, parseProcNetUdp } from "./network-forensics.js";
import { DEPLOYMENTS } from "./deployment.js";

/**
 * § Runtime Data Path Verification. The fixtures below are REAL `/proc` content captured from a
 * running Linux kernel in this repo's own CI/dev sandbox (verified byte-for-byte against
 * `dgram`'s own `address()`/`getRecvBufferSize()` for the UDP row) — not hand-written guesses at
 * the format. A parser for a forensic source is worthless if it was written against an imagined
 * layout, which is exactly the class of error this whole investigation exists to avoid.
 */
const REAL_PROC_NET_ROUTE = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
eth0	00000000	010200C0	0003	0	0	0	00000000	0	0	0
docker0	000011AC	00000000	0001	0	0	0	0000FFFF	0	0	0
eth0	000200C0	00000000	0001	0	0	0	00FFFFFF	0	0	0
`;

/** A real row for a socket genuinely bound to 0.0.0.0:10009 (port 0x2719). */
const REAL_PROC_NET_UDP = `   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
   28: 00000000:2719 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 5569 2 0000000000000000 0
   31: 00000000:14E9 00000000:0000 07 00000000:00000040 00:00000000 00000000  1000        0 7712 2 0000000000000000 17
`;

describe("parseKernelHexAddress", () => {
  it("converts the kernel's little-endian notation to a dotted quad", () => {
    expect(parseKernelHexAddress("010200C0")).toBe("192.0.2.1");
    expect(parseKernelHexAddress("0000FFFF")).toBe("255.255.0.0");
    expect(parseKernelHexAddress("00000000")).toBe("0.0.0.0");
  });

  it("returns null for anything that is not 8 hex digits, rather than guessing", () => {
    expect(parseKernelHexAddress("C0A801")).toBeNull();
    expect(parseKernelHexAddress("not-hex!")).toBeNull();
    expect(parseKernelHexAddress("")).toBeNull();
  });
});

describe("parseProcNetRoute (real kernel content)", () => {
  it("finds the default route and decodes its real gateway", () => {
    const routes = parseProcNetRoute(REAL_PROC_NET_ROUTE);
    const def = routes.filter((r) => r.isDefault);
    expect(def).toHaveLength(1);
    expect(def[0]).toMatchObject({ interfaceName: "eth0", destination: "0.0.0.0", gateway: "192.0.2.1", mask: "0.0.0.0" });
    // RTF_UP | RTF_GATEWAY — what actually makes it usable as a default route.
    expect(def[0]!.flags & 0x2).toBe(0x2);
  });

  it("decodes on-link subnet routes without mistaking them for a default route", () => {
    const routes = parseProcNetRoute(REAL_PROC_NET_ROUTE);
    const onLink = routes.find((r) => r.destination === "192.0.2.0");
    expect(onLink).toMatchObject({ interfaceName: "eth0", mask: "255.255.255.0", gateway: "0.0.0.0", isDefault: false });
  });

  it("reports NO default route for a namespace that has none — the decisive ENETUNREACH finding", () => {
    const noDefault = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
eth0	000012AC	00000000	0001	0	0	0	0000FFFF	0	0	0
`;
    const routes = parseProcNetRoute(noDefault);
    expect(routes.some((r) => r.isDefault)).toBe(false);
    expect(routes).toHaveLength(1);
  });

  it("skips malformed rows instead of emitting a half-parsed route", () => {
    expect(parseProcNetRoute("Iface\tDestination\ngarbage\n")).toEqual([]);
  });
});

describe("parseProcNetUdp (real kernel content)", () => {
  it("decodes a real bound socket's address, port, and kernel drop counter", () => {
    const sockets = parseProcNetUdp(REAL_PROC_NET_UDP);
    const s = sockets.find((x) => x.localPort === 10009);
    expect(s).toMatchObject({ localAddress: "0.0.0.0", localPort: 10009, drops: 0, rxQueue: 0, inode: 5569 });
  });

  it("surfaces a NON-zero kernel drop count — packets that reached the socket and were then lost", () => {
    const sockets = parseProcNetUdp(REAL_PROC_NET_UDP);
    const busy = sockets.find((x) => x.localPort === 5353);
    // This is a completely different diagnosis from "nothing ever arrived", which is why it is
    // read from the kernel rather than inferred from application counters.
    expect(busy).toMatchObject({ drops: 17, rxQueue: 0x40 });
  });
});

describe("findKernelSocket", () => {
  const sockets = parseProcNetUdp(REAL_PROC_NET_UDP);

  it("matches a wildcard-bound socket by port — how every socket in this service binds", () => {
    expect(findKernelSocket(sockets, "0.0.0.0", 10009)?.inode).toBe(5569);
  });

  it("returns null rather than a fabricated row when the kernel has no matching socket", () => {
    expect(findKernelSocket(sockets, "0.0.0.0", 9999)).toBeNull();
    expect(findKernelSocket(null, "0.0.0.0", 10009)).toBeNull();
    expect(findKernelSocket(sockets, "0.0.0.0", null)).toBeNull();
  });
});

describe("collectNetworkForensics against the REAL running system", () => {
  it("reads live interfaces and labels the deployment as configured, never observed", async () => {
    const f = await collectNetworkForensics(DEPLOYMENTS["native-linux"]);
    expect(f.platform).toBe(process.platform);
    expect(f.hostname).toBe((await import("node:os")).hostname());
    expect(f.interfaces.some((i) => i.internal && i.address === "127.0.0.1")).toBe(true);
    expect(f.configuredDeployment).toMatchObject({ id: "native-linux", lanAccess: "direct" });
  });

  it("reads the real routing table and namespace identity on Linux, and says so honestly elsewhere", async () => {
    const f = await collectNetworkForensics(DEPLOYMENTS.unknown);
    if (process.platform === "linux") {
      expect(f.procAvailable).toBe(true);
      expect(f.routes).not.toBeNull();
      expect(f.networkNamespace).toMatch(/^net:\[\d+\]$/);
      expect(f.rmemDefault).toBeGreaterThan(0);
      expect(f.udpSockets).not.toBeNull();
    } else {
      expect(f.procAvailable).toBe(false);
      expect(f.routes).toBeNull();
      expect(f.networkNamespace).toBeNull();
      // The honesty requirement: unavailable, with the reason — never a fabricated empty table.
      expect(f.unavailable.some((u) => u.field === "proc")).toBe(true);
    }
  });

  it("never reports a fabricated default gateway — null means the namespace genuinely has none", async () => {
    const f = await collectNetworkForensics(DEPLOYMENTS.unknown);
    if (f.defaultGateway !== null) {
      expect(f.routes?.some((r) => r.isDefault && r.gateway === f.defaultGateway)).toBe(true);
    }
  });
});
