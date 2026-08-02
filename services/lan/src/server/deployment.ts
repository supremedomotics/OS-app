/**
 * § Production Architecture Direction — deployment identity, isolated.
 *
 * SupremeOS's primary target is a dedicated OS image where `supreme-lan` runs as a native system
 * service (systemd) with direct access to the physical NICs. Docker is a development and CI
 * environment only. This module exists so that fact is structural rather than aspirational: it is
 * the ONE place in `@supreme/lan` allowed to know deployment-specific vocabulary ("docker",
 * "bridge", compose file names, systemd units). Everything else in the transport — sessions,
 * the wire protocol, routing diagnosis — reasons only about {@link LanAccess}, which is a
 * property of the network namespace, not of any container runtime.
 *
 * Why that split matters concretely: "bridge" / "host" / "macvlan" are Docker terms. On a native
 * SupremeOS image none of them mean anything, yet the transport previously carried them in its
 * wire protocol and branched on them in its failure diagnosis. Removing Docker would have meant
 * touching the transport. Now it means adding one entry here.
 *
 * Adding a future deployment (a hardware appliance, a VM template, a k8s DaemonSet) is one entry
 * in {@link DEPLOYMENTS} — no change to any protocol driver, and no change to the transport.
 */

/** Whether this process can reach the physical LAN directly. THE deployment-neutral fact the
 * transport reasons about — true or false regardless of Docker, systemd, VM, or bare metal.
 *
 *  - `direct`   — the process shares the host's network namespace (native service, Docker
 *                 `network_mode: host`, macvlan, bridged VM). Broadcast/multicast reception works.
 *  - `isolated` — the process is behind a NAT'd virtual network. Unicast egress may work;
 *                 broadcast/multicast reception does NOT (verified experimentally, see
 *                 `docs/architecture/Casambi-LAN-Receive-Path-Investigation.md`).
 *  - `unknown`  — not configured. Reported honestly rather than guessed; a process cannot
 *                 reliably self-detect this from inside its own namespace. */
export type LanAccess = "direct" | "isolated" | "unknown";

export type LanDeploymentId = "native-linux" | "docker-host" | "docker-bridge" | "macvlan" | "vm-bridged" | "unknown";

export interface LanDeployment {
  id: LanDeploymentId;
  /** Human label for diagnostics UI. */
  label: string;
  lanAccess: LanAccess;
  /** True only for deployments that are development/CI conveniences rather than the shipping
   * target — lets diagnostics say "this limitation is a dev-environment artifact, not a product
   * defect" without the transport itself knowing what Docker is. */
  developmentOnly: boolean;
  /** Deployment-specific remediation for "no LAN access". The ONLY place Docker/systemd-specific
   * instructions are allowed to live. `null` when the deployment already has direct access. */
  noLanAccessRemedy: string | null;
  /** Platforms where this deployment's declared {@link lanAccess} does NOT actually hold, keyed by
   * `process.platform`, with the real reason. Diagnostics append the note verbatim instead of
   * knowing which runtimes are affected — the same reason `noLanAccessRemedy` lives here. `null`
   * when the deployment's claim holds everywhere it can run. */
  unreliableLanAccessOn: Partial<Record<NodeJS.Platform, string>> | null;
}

/** Docker Desktop runs Linux containers inside a VM, so `network_mode: host` attaches to the VM's
 * network namespace rather than the workstation's. The flag is accepted and does nothing —
 * precisely the silent false-PASS this model exists to surface. */
const DOCKER_DESKTOP_HOST_NETWORKING_NOOP =
  "this deployment claims direct LAN access, but Docker Desktop does not implement host networking for Linux containers on this platform (it runs them inside a VM), so the claim does not hold here. Run supreme-lan as a native process, or use a Linux host.";

export const DEPLOYMENTS: Record<LanDeploymentId, LanDeployment> = {
  "native-linux": {
    id: "native-linux",
    label: "Native Linux service (systemd)",
    lanAccess: "direct",
    developmentOnly: false,
    noLanAccessRemedy: null,
    unreliableLanAccessOn: null,
  },
  "docker-host": {
    id: "docker-host",
    label: "Docker (host networking)",
    lanAccess: "direct",
    developmentOnly: true,
    noLanAccessRemedy: null,
    unreliableLanAccessOn: { win32: DOCKER_DESKTOP_HOST_NETWORKING_NOOP, darwin: DOCKER_DESKTOP_HOST_NETWORKING_NOOP },
  },
  "docker-bridge": {
    id: "docker-bridge",
    label: "Docker (bridge networking)",
    lanAccess: "isolated",
    developmentOnly: true,
    noLanAccessRemedy:
      "Docker bridge networking cannot receive LAN broadcast or multicast — this is a development-environment limitation, not a SupremeOS defect, and it does not exist in the production (native service) deployment. For development on Linux, layer `-f docker-compose.nats-loopback.yml -f docker-compose.lan-host.yml`. On Windows/macOS Docker Desktop host networking is a no-op for Linux containers; run supreme-lan as a native process instead (`node dist/server/main.js` with SUPREME_LAN_DEPLOYMENT=native-linux).",
    unreliableLanAccessOn: null,
  },
  macvlan: {
    id: "macvlan",
    label: "Docker (macvlan)",
    lanAccess: "direct",
    developmentOnly: true,
    noLanAccessRemedy: null,
    unreliableLanAccessOn: { win32: DOCKER_DESKTOP_HOST_NETWORKING_NOOP, darwin: DOCKER_DESKTOP_HOST_NETWORKING_NOOP },
  },
  "vm-bridged": {
    id: "vm-bridged",
    label: "Virtual machine (bridged adapter)",
    lanAccess: "direct",
    developmentOnly: false,
    noLanAccessRemedy: null,
    unreliableLanAccessOn: null,
  },
  unknown: {
    id: "unknown",
    label: "Unknown",
    lanAccess: "unknown",
    developmentOnly: false,
    noLanAccessRemedy:
      "Set SUPREME_LAN_DEPLOYMENT so diagnostics can tell whether this process is expected to have direct LAN access. It is deliberately not auto-detected: a process cannot reliably determine from inside its own network namespace whether it shares the host's, so guessing would produce confidently wrong diagnostics.",
    unreliableLanAccessOn: null,
  },
};

/** Legacy `SUPREME_LAN_NETWORK_MODE` values, kept working so existing compose files and any
 * deployed unit keep behaving identically. Mapped to the neutral model rather than reinterpreted.
 * `host` deliberately maps to `docker-host` (not `native-linux`) because that variable was only
 * ever set by this repo's Compose files. */
const LEGACY_NETWORK_MODE: Record<string, LanDeploymentId> = {
  bridge: "docker-bridge",
  host: "docker-host",
  macvlan: "macvlan",
};

/**
 * Resolves the deployment from environment. Precedence: the explicit, deployment-neutral
 * `SUPREME_LAN_DEPLOYMENT`, then the legacy Docker-shaped `SUPREME_LAN_NETWORK_MODE`, then
 * `unknown`. Never auto-detected — see `DEPLOYMENTS.unknown.noLanAccessRemedy` for why.
 */
export function resolveDeployment(env: NodeJS.ProcessEnv = process.env): LanDeployment {
  const explicit = env.SUPREME_LAN_DEPLOYMENT;
  if (explicit && explicit in DEPLOYMENTS) return DEPLOYMENTS[explicit as LanDeploymentId];
  const legacy = env.SUPREME_LAN_NETWORK_MODE;
  if (legacy && legacy in LEGACY_NETWORK_MODE) return DEPLOYMENTS[LEGACY_NETWORK_MODE[legacy]!];
  return DEPLOYMENTS.unknown;
}
