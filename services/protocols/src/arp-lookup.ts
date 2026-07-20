import { readFileSync } from "node:fs";

/**
 * Best-effort local ARP-table MAC lookup (§ Discovery Engine, Stage 2 Metadata
 * Enrichment). SSDP/mDNS payloads never carry a MAC address — the only place a MAC is
 * genuinely learnable without touching the wire protocol is the host's own ARP cache,
 * populated automatically by the kernel for any IP the hub has already exchanged
 * packets with (which every just-discovered/just-bound device has, by definition).
 * This is intentionally NOT active ARP probing — it only reads what the kernel already
 * knows, so it's as passive as reading `/proc/net/arp` on a Linux hub host/container.
 *
 * Returns `null` (never a guess) when: the platform isn't Linux, `/proc/net/arp` isn't
 * readable (sandboxed/rootless container, permissions), or the IP simply isn't in the
 * table yet (kernel hasn't ARPed it — most likely on a fresh boot before any traffic).
 */
export function bestEffortMacForIp(ip: string, arpTablePath = "/proc/net/arp"): string | null {
  if (process.platform !== "linux") return null;
  let contents: string;
  try {
    contents = readFileSync(arpTablePath, "utf8");
  } catch {
    return null;
  }
  return parseArpTable(contents, ip);
}

const NULL_MAC = "00:00:00:00:00:00";

/** Exported separately for testing without touching the real filesystem. */
export function parseArpTable(contents: string, ip: string): string | null {
  const lines = contents.split("\n").slice(1); // header row: "IP address  HW type  Flags  HW address  Mask  Device"
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [rowIp, , , mac] = cols;
    if (rowIp !== ip) continue;
    if (!mac || mac.toLowerCase() === NULL_MAC) return null; // incomplete ARP entry
    return mac.toLowerCase();
  }
  return null;
}
