import { readFile } from "node:fs/promises";

/**
 * Best-effort MAC-address resolution from the kernel neighbor table (§ dedup/identity — MAC tier).
 *
 * This reads `/proc/net/arp` only — the same table the kernel already populates as a side effect
 * of the ARP traffic the OS emits while this driver's own discovery packets (WS-Discovery
 * multicast, RTSP TCP probes) are sent to LAN hosts. It performs NO active ARP scanning, opens no
 * raw socket, and needs no elevated privileges: `/proc/net/arp` is world-readable on every Linux
 * distribution this hub ships on (verified in this sandbox container, which runs unprivileged).
 *
 * Feasibility note (see SESSION_HANDOFF.md for the full write-up): `ip neighbor` would be the
 * more modern equivalent, but it depends on the `iproute2` package being installed in the
 * container image, which is not guaranteed — `/proc/net/arp` requires nothing beyond the kernel
 * itself, so it is the more portable choice for a hub base image.
 *
 * This is deliberately advisory-only:
 *  - Never awaited by discovery's own timeout budget — callers fetch it in parallel with, not
 *    blocking, the ONVIF/RTSP probes, and apply a short independent timeout.
 *  - Any failure (file missing, permission denied, malformed line, not running on Linux) resolves
 *    to an empty map, never throws — a camera is still discovered/identified via the existing
 *    UUID/manufacturer+model/IP tiers when MAC can't be resolved.
 *  - Never exposed to installer-facing UI/API responses — see rtsp-identity.ts, where it is
 *    consumed only to strengthen the internal dedup key, and rtsp-types.ts, whose
 *    `RtspDiscoveryResult` intentionally has no `mac` field.
 */
export async function readArpTable(timeoutMs = 500): Promise<Map<string, string>> {
  const table = new Map<string, string>();
  try {
    const text = await Promise.race([
      readFile("/proc/net/arp", "utf8"),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("arp read timed out")), timeoutMs)),
    ]);
    const lines = text.split("\n").slice(1); // header: "IP address ... HW address ..."
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const [ip, , flags, mac] = cols;
      if (!ip || !mac) continue;
      // Flags column 0x0 means "incomplete" (no resolved hardware address yet) — skip those, and
      // skip the well-known all-zero placeholder MAC some kernels report for such entries.
      if (flags === "0x0") continue;
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) continue;
      if (mac === "00:00:00:00:00:00") continue;
      table.set(ip, mac.toLowerCase());
    }
  } catch {
    // Not on Linux, /proc unavailable in this container, permission denied, or timed out — a
    // camera is still identified via the other tiers (§ STEP 6). Never fatal to discovery.
  }
  return table;
}
