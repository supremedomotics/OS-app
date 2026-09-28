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

/** The /24 this address belongs to, as a list of every host IP in range (1-254) — used by the
 * RTSP-port fallback scan, which is bounded to each interface's OWN local subnet only (never an
 * arbitrary/unrelated range) per STEP 3's "no uncontrolled full port scans" requirement. Returns
 * `[]` for a non-IPv4-looking address rather than guessing. */
export function subnetHosts(localAddress: string): string[] {
  const m = localAddress.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return [];
  const [, a, b, c] = m;
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i++) hosts.push(`${a}.${b}.${c}.${i}`);
  return hosts;
}
