import os from "node:os";
import { type LanDeployment } from "./deployment.js";

/**
 * § ENETUNREACH investigation — routing diagnosis. Turns a raw OS send error into an
 * installer-readable explanation of WHICH layer failed (deployment / routing / gateway /
 * protocol), so "supreme-lan: send failed — send ENETUNREACH 192.168.0.45:10009" stops being a
 * dead end.
 *
 * Everything here is derived from facts this process can actually observe (`os.networkInterfaces()`,
 * `os.platform()`, the configured network mode, the real error code) or from a documented,
 * reproducible property of Docker networking. Nothing is guessed: where a fact cannot be
 * determined from inside the process — most importantly whether a container is REALLY on
 * `network_mode: host`, which looks near-identical from the inside — the field stays `null` and
 * the explanation says so rather than asserting a deployment shape.
 *
 * Root cause this exists to name (verified experimentally, not assumed — see
 * `docs/architecture/Casambi-ENETUNREACH-Investigation.md`): a container whose ONLY network is
 * Docker-`internal: true` has no default route off the host at all, so the kernel rejects any
 * send to an off-subnet address with `ENETUNREACH` before a packet leaves the process. The base
 * `docker-compose.yml` attaches `lan` to `supreme-core`, which IS `internal: true`.
 */

export type RoutingVerdict = "ok" | "no_route" | "host_unreachable" | "permission_denied" | "unknown_error";

export interface RoutingDiagnosis {
  /** The real `NodeJS.ErrnoException.code` from the failed send (e.g. "ENETUNREACH"), or `null`
   * when diagnosing without a specific failure. */
  errorCode: string | null;
  verdict: RoutingVerdict;
  destination: string;
  /** Every real IPv4 interface this process can see. */
  interfaces: { name: string; address: string; cidr: string | null; internal: boolean }[];
  /** The interface whose subnet actually contains `destination`, if any — computed from real
   * CIDR masks, not guessed. `null` means NO local interface is on the destination's subnet,
   * which is itself the key finding for an `ENETUNREACH`. */
  outboundInterface: { name: string; address: string } | null;
  platform: NodeJS.Platform;
  /** § Production Architecture Direction — the deployment this service was CONFIGURED as (never
   * self-detected; see `deployment.ts`). Deployment-specific vocabulary lives entirely in that
   * module — this diagnosis branches only on `deployment.lanAccess`, which is meaningful for a
   * native SupremeOS service, a VM, and a container alike. */
  deployment: LanDeployment;
  /** Plain-language statement of what the evidence shows. */
  explanation: string;
  /** Concrete, actionable next step. Never "check the logs". */
  suggestedFix: string | null;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

/** True when `ip` falls inside `cidr` (e.g. "172.18.0.2/16") — real mask arithmetic, so
 * "is my container even on the gateway's subnet?" is answered, not assumed. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (!base || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function verdictFor(errorCode: string | null): RoutingVerdict {
  switch (errorCode) {
    case null:
      return "ok";
    case "ENETUNREACH":
      return "no_route";
    case "EHOSTUNREACH":
      return "host_unreachable";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    default:
      return "unknown_error";
  }
}

export function diagnoseRouting(opts: {
  destination: string;
  errorCode: string | null;
  deployment: LanDeployment;
}): RoutingDiagnosis {
  const interfaces: RoutingDiagnosis["interfaces"] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4") interfaces.push({ name, address: addr.address, cidr: addr.cidr ?? null, internal: addr.internal });
    }
  }

  const match = interfaces.find((i) => !i.internal && i.cidr !== null && ipInCidr(opts.destination, i.cidr));
  const outboundInterface = match ? { name: match.name, address: match.address } : null;
  const verdict = verdictFor(opts.errorCode);
  const platform = os.platform();

  let explanation: string;
  let suggestedFix: string | null = null;

  if (verdict === "ok") {
    explanation = `No send error reported. ${outboundInterface ? `Destination ${opts.destination} is on the same subnet as interface ${outboundInterface.name} (${outboundInterface.address}).` : `Destination ${opts.destination} is not on any local subnet — traffic would be routed via a default gateway.`}`;
  } else if (verdict === "no_route") {
    // Branches on the deployment-NEUTRAL `lanAccess` property, never on a container-runtime term.
    // Deployment-specific remediation text comes from `deployment.ts`, the one module allowed to
    // know what Docker/systemd are — so a future SupremeOS-image deployment needs no change here.
    explanation =
      `The operating system rejected the send before any packet left the process: there is no route from this process's network namespace to ${opts.destination}. ` +
      (outboundInterface
        ? `An interface (${outboundInterface.name}, ${outboundInterface.address}) IS on that subnet, so the network namespace is not the constraint — check host firewall/routing rules.`
        : `No local interface is on ${opts.destination}'s subnet, and no usable default route exists. Visible interfaces: ${interfaces.filter((i) => !i.internal).map((i) => `${i.name}=${i.cidr ?? i.address}`).join(", ") || "(none besides loopback)"}.`);
    suggestedFix =
      opts.deployment.noLanAccessRemedy ??
      `This deployment (${opts.deployment.label}) is expected to have direct LAN access, yet there is no route to ${opts.destination}. Verify the host itself can reach it (\`ping ${opts.destination}\`, \`ip route get ${opts.destination}\`) — if the host cannot either, the problem is the physical network (VLAN, subnet, firewall), not SupremeOS.`;
  } else if (verdict === "host_unreachable") {
    explanation = `A route to ${opts.destination}'s network exists, but the host itself did not respond (no ARP reply / ICMP host unreachable). The network path is correct; the specific device is not answering.`;
    suggestedFix = `Confirm the gateway is powered on and at ${opts.destination} (its own web UI, or \`ping ${opts.destination}\` from the same host). This is a gateway/addressing issue, not a SupremeOS or routing issue.`;
  } else if (verdict === "permission_denied") {
    explanation = `The OS refused the send with ${opts.errorCode}. For a broadcast destination this usually means SO_BROADCAST was not set; otherwise it is a sandbox/capability restriction on the process.`;
    suggestedFix = "If sending to a broadcast address, ensure the bind used `broadcast: true`. Otherwise check container capabilities / host security policy (AppArmor, SELinux).";
  } else {
    explanation = `The OS reported ${opts.errorCode} sending to ${opts.destination}. This is not one of the routing errors this diagnosis recognizes.`;
    suggestedFix = null;
  }

  // A deployment can declare direct LAN access that the real platform silently does not honor.
  // Which deployments, on which platforms, and why is deployment knowledge — it lives in
  // `deployment.ts`; this only matches the observed `process.platform` against that table and
  // appends the note verbatim.
  const platformCaveat = opts.deployment.unreliableLanAccessOn?.[platform];
  if (verdict !== "ok" && platformCaveat) {
    explanation += ` NOTE: ${opts.deployment.label} on platform ${platform} — ${platformCaveat}`;
  }

  return {
    errorCode: opts.errorCode,
    verdict,
    destination: opts.destination,
    interfaces,
    outboundInterface,
    platform,
    deployment: opts.deployment,
    explanation,
    suggestedFix,
  };
}
