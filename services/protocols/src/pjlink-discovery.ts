import type { UdpTransport, UdpTransportFactory } from "@supreme/lan";
import { LocalDirectUdpTransport } from "@supreme/lan";
import { PJLINK_DEFAULT_PORT } from "./pjlink-codec.js";

/**
 * PJLink Class 2 discovery (§ JBMIA "PJLink Specifications (Class 2)", search/discovery
 * addendum). Class 2 adds a UDP search mechanism on the SAME port TCP control uses
 * (4352, this codebase's `PJLINK_DEFAULT_PORT`): a controller broadcasts
 * `%2SRCH\r` to the subnet broadcast address on port 4352; every Class-2-capable
 * projector currently reachable answers with a UDP broadcast reply
 * `%2ACKN=<ip-address>\r` (its own IP, so a controller that can't inspect the UDP
 * source address directly still gets a usable answer). A projector that comes online
 * AFTER the search window closes additionally announces itself with an unsolicited
 * `%2LNKUP=<MAC>\r` broadcast — NOT implemented here (this driver's `discover()` is a
 * one-shot scan, not a long-lived announcement listener; a future "live discovery feed"
 * would add a persistent `LNKUP` listener on top of this same transport).
 *
 * Class 1 has NO discovery mechanism at all (verified against the spec: search/SRCH is
 * a Class 2 addition) — a Class-1-only unit must be added manually by IP, exactly like
 * AVR's Telnet units.
 *
 * Uses `@supreme/lan`'s `UdpTransport` (never a raw socket) per this fleet's LAN
 * transport convention — see `services/lan/src/transport.ts`'s module doc and
 * `lan-adapters/ssdp-remote-socket.ts` for the same pattern applied to SSDP.
 */

const SEARCH_WINDOW_MS = 3_000;
const BROADCAST_ADDRESS = "255.255.255.255";

export interface PjlinkDiscoveryCandidate {
  /** The projector's own IP, as reported IN the `ACKN` reply body — real wire data, not
   * the UDP source address (the two should match; the reply body is authoritative per
   * spec, matching how a controller is meant to use it). */
  address: string;
}

export interface PjlinkDiscoveryOptions {
  udpTransportFactory?: UdpTransportFactory;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  windowMs?: number;
  port?: number;
}

export async function discoverPjlinkClass2(opts: PjlinkDiscoveryOptions = {}): Promise<PjlinkDiscoveryCandidate[]> {
  const port = opts.port ?? PJLINK_DEFAULT_PORT;
  const transport: UdpTransport = opts.udpTransportFactory ? opts.udpTransportFactory() : new LocalDirectUdpTransport();
  const found = new Map<string, PjlinkDiscoveryCandidate>();
  const unsubMessage = transport.onMessage((msg: Buffer, rinfo: { address: string; port: number }) => {
    const text = msg.toString("utf8").trim();
    const m = /^%2ACKN=(.+)$/.exec(text);
    if (m) {
      const address = (m[1] ?? "").trim() || rinfo.address;
      found.set(address, { address });
    }
  });
  const unsubError = transport.onError((err: Error) => {
    opts.onLog?.("warn", `pjlink discovery: transport error — ${err.message}`);
  });
  try {
    await transport.bind({ broadcast: true });
    await transport.send(Buffer.from("%2SRCH\r", "ascii"), port, BROADCAST_ADDRESS);
    await new Promise((resolve) => setTimeout(resolve, opts.windowMs ?? SEARCH_WINDOW_MS));
  } finally {
    unsubMessage();
    unsubError();
    await transport.close();
  }
  return [...found.values()];
}
