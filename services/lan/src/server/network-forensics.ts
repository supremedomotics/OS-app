import os from "node:os";
import { readFile, readlink } from "node:fs/promises";
import type { LanDeployment } from "./deployment.js";

/**
 * § Runtime Data Path Verification — "No assumptions. Read everything from the running system."
 *
 * Every field here is read from the live kernel at call time (`/proc`, `os.*`) or is `null` with a
 * stated reason. Nothing is inferred, defaulted, or carried over from configuration — the one
 * exception is the deployment identity, which is explicitly *configured* (see `deployment.ts`) and
 * is labelled as such in the output so it is never mistaken for an observation.
 *
 * The `/proc` sources are Linux kernel interfaces, not container-runtime ones: they read
 * identically for a native SupremeOS system service and for a containerized process, each seeing
 * its OWN network namespace. That is exactly the property that makes them useful here — a process
 * cannot self-report which namespace it is in, but it CAN report what that namespace contains, and
 * an empty/odd routing table or a missing default route is then visible as fact rather than
 * deduced. On a non-Linux platform `/proc` does not exist; those fields report `null` plus
 * `procAvailable: false` rather than a fabricated empty table.
 */

export interface ForensicInterface {
  name: string;
  address: string;
  netmask: string;
  family: string;
  mac: string;
  internal: boolean;
  cidr: string | null;
}

export interface ForensicRoute {
  interfaceName: string;
  /** Dotted-quad destination network ("0.0.0.0" for the default route). */
  destination: string;
  gateway: string;
  mask: string;
  /** Raw kernel flags. Bit 0 = RTF_UP, bit 1 = RTF_GATEWAY. */
  flags: number;
  isDefault: boolean;
  metric: number;
}

/** One row of the kernel's UDP socket table — the authoritative answer to "did the kernel queue or
 * drop anything for this socket?", which no application-level counter can provide. */
export interface ForensicUdpSocket {
  localAddress: string;
  localPort: number;
  /** Bytes currently sitting unread in the kernel receive queue. Persistently non-zero means the
   * application is not draining fast enough. */
  rxQueue: number;
  txQueue: number;
  /** Datagrams the kernel DROPPED for this socket (receive buffer overflow). Non-zero proves
   * packets reached the socket and were lost after that — a completely different diagnosis from
   * "nothing ever arrived". */
  drops: number;
  inode: number;
  uid: number;
}

export interface NetworkForensics {
  collectedAt: string;
  platform: NodeJS.Platform;
  hostname: string;
  /** Configured, NOT observed — labelled explicitly so it is never read as evidence. */
  configuredDeployment: { id: string; label: string; lanAccess: string; developmentOnly: boolean };
  interfaces: ForensicInterface[];
  /** `false` on any platform without `/proc` (macOS, Windows); every `/proc`-sourced field below
   * is then `null` rather than empty. */
  procAvailable: boolean;
  /** The process's network namespace identity, e.g. `net:[4026531833]`. Two processes reporting the
   * SAME value share a namespace; different values mean they do not, and cannot see each other's
   * traffic. This is the one fact that settles "is this process really on the host's network?" —
   * compare it against `readlink /proc/1/ns/net` on the host itself. */
  networkNamespace: string | null;
  routes: ForensicRoute[] | null;
  /** The default route's gateway, or `null` when the namespace has NO default route — which is
   * itself the decisive finding for an `ENETUNREACH`, not a missing measurement. */
  defaultGateway: string | null;
  /** Kernel-wide default and maximum socket receive buffer sizes, for comparing against a socket's
   * actual `getRecvBufferSize()`. */
  rmemDefault: number | null;
  rmemMax: number | null;
  /** Every UDP socket open in this namespace, with the kernel's own drop counters. */
  udpSockets: ForensicUdpSocket[] | null;
  /** Anything that could not be read, with the real reason. Empty when everything succeeded. */
  unavailable: { field: string; reason: string }[];
}

/** Converts the kernel's little-endian hex address notation (`0101A8C0`) to dotted quad
 * (`192.168.1.1`). Returns `null` for anything that is not 8 hex digits, rather than guessing. */
export function parseKernelHexAddress(hex: string): string | null {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
  const bytes = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6), hex.slice(6, 8)].map((b) => parseInt(b, 16));
  return bytes.reverse().join(".");
}

/** Parses `/proc/net/route`. Exported for direct testing against real captured content. */
export function parseProcNetRoute(content: string): ForensicRoute[] {
  const routes: ForensicRoute[] = [];
  const lines = content.trim().split("\n").slice(1); // drop the header row
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const destination = parseKernelHexAddress(cols[1]!);
    const gateway = parseKernelHexAddress(cols[2]!);
    const mask = parseKernelHexAddress(cols[7]!);
    if (destination === null || gateway === null || mask === null) continue;
    const flags = parseInt(cols[3]!, 16);
    routes.push({
      interfaceName: cols[0]!,
      destination,
      gateway,
      mask,
      flags,
      // RTF_GATEWAY (0x2) on the 0.0.0.0/0 destination is what makes a route THE default route.
      isDefault: destination === "0.0.0.0" && mask === "0.0.0.0",
      metric: Number(cols[6] ?? 0),
    });
  }
  return routes;
}

/** Parses `/proc/net/udp`. Exported for direct testing against real captured content. */
export function parseProcNetUdp(content: string): ForensicUdpSocket[] {
  const sockets: ForensicUdpSocket[] = [];
  const lines = content.trim().split("\n").slice(1); // drop the header row
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    // sl local_address rem_address st tx_queue:rx_queue tr tm->when retrnsmt uid timeout inode
    // ref pointer drops  — `drops` is the last column.
    if (cols.length < 13) continue;
    const [addrHex, portHex] = (cols[1] ?? "").split(":");
    const address = addrHex ? parseKernelHexAddress(addrHex) : null;
    if (address === null || !portHex) continue;
    const [tx, rx] = (cols[4] ?? "").split(":");
    sockets.push({
      localAddress: address,
      localPort: parseInt(portHex, 16),
      txQueue: parseInt(tx ?? "0", 16),
      rxQueue: parseInt(rx ?? "0", 16),
      drops: Number(cols[cols.length - 1] ?? 0),
      inode: Number(cols[9] ?? 0),
      uid: Number(cols[7] ?? 0),
    });
  }
  return sockets;
}

async function readOptional(path: string, unavailable: { field: string; reason: string }[], field: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    unavailable.push({ field, reason: `${path}: ${err instanceof Error ? err.message : String(err)}` });
    return null;
  }
}

export async function collectNetworkForensics(deployment: LanDeployment): Promise<NetworkForensics> {
  const unavailable: { field: string; reason: string }[] = [];

  const interfaces: ForensicInterface[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      interfaces.push({
        name,
        address: addr.address,
        netmask: addr.netmask,
        family: String(addr.family),
        mac: addr.mac,
        internal: addr.internal,
        cidr: addr.cidr ?? null,
      });
    }
  }

  const procAvailable = process.platform === "linux";
  if (!procAvailable) {
    unavailable.push({ field: "proc", reason: `/proc is a Linux kernel interface; this process is running on ${process.platform}. Routing table, namespace identity, and kernel socket drop counters are genuinely unavailable here — not zero.` });
  }

  const routeRaw = procAvailable ? await readOptional("/proc/net/route", unavailable, "routes") : null;
  const udpRaw = procAvailable ? await readOptional("/proc/net/udp", unavailable, "udpSockets") : null;
  const rmemDefaultRaw = procAvailable ? await readOptional("/proc/sys/net/core/rmem_default", unavailable, "rmemDefault") : null;
  const rmemMaxRaw = procAvailable ? await readOptional("/proc/sys/net/core/rmem_max", unavailable, "rmemMax") : null;

  let networkNamespace: string | null = null;
  if (procAvailable) {
    try {
      networkNamespace = await readlink("/proc/self/ns/net");
    } catch (err) {
      unavailable.push({ field: "networkNamespace", reason: `/proc/self/ns/net: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const routes = routeRaw === null ? null : parseProcNetRoute(routeRaw);
  const defaultRoute = routes?.find((r) => r.isDefault) ?? null;

  return {
    collectedAt: new Date().toISOString(),
    platform: process.platform,
    hostname: os.hostname(),
    configuredDeployment: {
      id: deployment.id,
      label: deployment.label,
      lanAccess: deployment.lanAccess,
      developmentOnly: deployment.developmentOnly,
    },
    interfaces,
    procAvailable,
    networkNamespace,
    routes,
    defaultGateway: defaultRoute ? defaultRoute.gateway : null,
    rmemDefault: rmemDefaultRaw === null ? null : Number(rmemDefaultRaw.trim()),
    rmemMax: rmemMaxRaw === null ? null : Number(rmemMaxRaw.trim()),
    udpSockets: udpRaw === null ? null : parseProcNetUdp(udpRaw),
    unavailable,
  };
}

/**
 * The socket-level half of the same question, for ONE bound socket. Kept separate from
 * {@link NetworkForensics} because it needs a live socket handle, and because the honest answer
 * differs field by field:
 *
 * `recvBufferSize` is genuinely read back from the kernel (`getRecvBufferSize()`). SO_BROADCAST
 * and SO_REUSEADDR are **not readable through Node's `dgram` API** — there is no getter — so this
 * reports what was REQUESTED at bind time and says so in the field names, rather than presenting a
 * request as a verified kernel state. Where the kernel table can corroborate (a matching row in
 * `/proc/net/udp` proves the socket really is bound where it claims), that corroboration is
 * reported as its own field.
 */
export interface SocketForensics {
  boundAddress: string | null;
  boundPort: number | null;
  /** Real kernel value, read back after bind. */
  recvBufferSize: number | null;
  sendBufferSize: number | null;
  /** What the caller ASKED for at bind time. Node exposes no getter for the corresponding kernel
   * option, so these are requests, not confirmations — named accordingly. */
  requestedBroadcast: boolean;
  requestedReuseAddr: boolean;
  requestedMulticastGroup: string | null;
  requestedMulticastInterface: string | null;
  /** ISO timestamp of a successful `addMembership()`, or `null`. A successful join is NOT evidence
   * of reception (see `dgram-udp-session.ts`) and is reported separately for that reason. */
  joinedMulticastAt: string | null;
  /** The matching `/proc/net/udp` row, when one exists — independent kernel corroboration that the
   * socket is bound where it says, plus the kernel's own drop counter for it. `null` on a platform
   * without `/proc`, or when no row matches (which would itself be a finding). */
  kernelSocket: ForensicUdpSocket | null;
}

/** Finds the kernel's row for a bound socket. Matches the exact address first, then the wildcard
 * bind (`0.0.0.0`) on the same port, since binding all interfaces is what every socket in this
 * service does by default. Returns `null` — never a fabricated row — when nothing matches. */
export function findKernelSocket(sockets: ForensicUdpSocket[] | null, address: string | null, port: number | null): ForensicUdpSocket | null {
  if (!sockets || port === null) return null;
  return sockets.find((s) => s.localPort === port && s.localAddress === address) ?? sockets.find((s) => s.localPort === port && s.localAddress === "0.0.0.0") ?? null;
}
