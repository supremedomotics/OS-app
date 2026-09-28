import os from "node:os";

/** Every non-internal IPv4 address currently assigned to a real host interface (Ethernet/Wi-Fi/
 * VLAN/…), determined at runtime — never a hardcoded subnet (§ STEP 3). `os.networkInterfaces()`
 * already excludes nothing we need to exclude by name (unlike Windows adapter enumeration, which
 * needed the default-gateway heuristic documented in CLAUDE.md); `internal: true` (loopback) is
 * the only thing filtered here, which is the correct, minimal filter for a Linux hub container. */
export function localIPv4Interfaces(): string[] {
  const nets = os.networkInterfaces();
  const out: string[] = [];
  for (const addrs of Object.values(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

/** Ceiling on how many host addresses the RTSP fallback probe will ever generate for one
 * interface — matches this driver's "bounded, no uncontrolled port scanning" design (the same
 * philosophy `rtsp-port-probe.ts`'s `concurrency`/`timeoutMs` bounds follow): a /16 or wider VLAN
 * is real, but sweeping its full 65k+ host range is not, so the range is capped rather than
 * exploded in full (§ FINDING 5). A /24 (254 hosts) comfortably fits under this. */
export const MAX_SUBNET_PROBE_HOSTS = 1024;

/** The real subnet this address belongs to, as a list of every host IP in range — reads the
 * interface's actual netmask/prefix length from `os.networkInterfaces()` (its `netmask`/`cidr`
 * fields) instead of assuming a /24, so a /16 or /20 VLAN's cameras outside the matching /24 are
 * still probed, and a narrower subnet (e.g. /28) doesn't waste probes on addresses outside its
 * real range (§ FINDING 5). Falls back to a /24 guess only when no netmask is known for this
 * address (e.g. it was supplied directly by a caller/test rather than read from
 * `os.networkInterfaces()`). Bounded by {@link MAX_SUBNET_PROBE_HOSTS} for very large prefixes.
 * Returns `[]` for a non-IPv4-looking address rather than guessing. */
export function subnetHosts(localAddress: string, netmask?: string): string[] {
  const m = localAddress.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return [];
  const ip = ipToInt(m);
  if (ip === null) return [];

  const resolvedNetmask = netmask ?? findNetmaskForAddress(localAddress) ?? "255.255.255.0";
  const maskParts = resolvedNetmask.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  const mask = maskParts ? ipToInt(maskParts) : null;
  if (mask === null || mask === undefined) {
    // Malformed netmask — fall back to the previous, safe /24 behavior rather than guessing wider.
    return subnetHosts(localAddress, "255.255.255.0");
  }

  const network = ip & mask;
  const broadcast = network | (~mask >>> 0);
  const firstHost = network + 1;
  const lastHost = broadcast - 1;
  if (lastHost < firstHost) return [];

  const totalHosts = lastHost - firstHost + 1;
  const boundedLast = totalHosts > MAX_SUBNET_PROBE_HOSTS ? firstHost + MAX_SUBNET_PROBE_HOSTS - 1 : lastHost;

  const hosts: string[] = [];
  for (let i = firstHost; i <= boundedLast; i++) hosts.push(intToIp(i));
  return hosts;
}

function ipToInt(m: RegExpMatchArray): number {
  const [, a, b, c, d] = m;
  return ((Number(a) << 24) | (Number(b) << 16) | (Number(c) << 8) | Number(d)) >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Looks up the real netmask `os.networkInterfaces()` reports for a given local IPv4 address, so
 * `subnetHosts` can use the actual subnet instead of assuming /24. */
function findNetmaskForAddress(address: string): string | null {
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && addr.address === address && addr.netmask) return addr.netmask;
    }
  }
  return null;
}
