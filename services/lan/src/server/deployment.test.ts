import { describe, expect, it } from "vitest";
import { DEPLOYMENTS, resolveDeployment } from "./deployment.js";

describe("resolveDeployment", () => {
  it("reads the deployment-neutral SUPREME_LAN_DEPLOYMENT", () => {
    expect(resolveDeployment({ SUPREME_LAN_DEPLOYMENT: "native-linux" }).id).toBe("native-linux");
    expect(resolveDeployment({ SUPREME_LAN_DEPLOYMENT: "docker-bridge" }).id).toBe("docker-bridge");
  });

  // Backward compatibility: any already-deployed unit or older compose file keeps working
  // identically rather than silently falling back to "unknown".
  it("still honors the legacy Docker-shaped SUPREME_LAN_NETWORK_MODE", () => {
    expect(resolveDeployment({ SUPREME_LAN_NETWORK_MODE: "bridge" }).id).toBe("docker-bridge");
    expect(resolveDeployment({ SUPREME_LAN_NETWORK_MODE: "host" }).id).toBe("docker-host");
    expect(resolveDeployment({ SUPREME_LAN_NETWORK_MODE: "macvlan" }).id).toBe("macvlan");
  });

  it("prefers the neutral variable when both are set", () => {
    expect(resolveDeployment({ SUPREME_LAN_DEPLOYMENT: "native-linux", SUPREME_LAN_NETWORK_MODE: "bridge" }).id).toBe("native-linux");
  });

  it("returns 'unknown' rather than guessing when nothing is configured", () => {
    const d = resolveDeployment({});
    expect(d.id).toBe("unknown");
    expect(d.lanAccess).toBe("unknown");
    // Must explain WHY it isn't auto-detected, so nobody 'fixes' it by adding detection.
    expect(d.noLanAccessRemedy).toMatch(/cannot reliably determine from inside its own network namespace/);
  });

  it("ignores an unrecognized value instead of trusting it", () => {
    expect(resolveDeployment({ SUPREME_LAN_DEPLOYMENT: "not-a-real-deployment" }).id).toBe("unknown");
  });
});

describe("DEPLOYMENTS — the deployment-neutral lanAccess model", () => {
  it("marks every deployment that shares the host network namespace as direct LAN access", () => {
    for (const id of ["native-linux", "docker-host", "macvlan", "vm-bridged"] as const) {
      expect(DEPLOYMENTS[id].lanAccess, id).toBe("direct");
      // Direct access means there is nothing to remediate.
      expect(DEPLOYMENTS[id].noLanAccessRemedy, id).toBeNull();
    }
  });

  it("marks ONLY docker-bridge as isolated, and gives it a concrete remedy", () => {
    expect(DEPLOYMENTS["docker-bridge"].lanAccess).toBe("isolated");
    expect(DEPLOYMENTS["docker-bridge"].noLanAccessRemedy).toMatch(/docker-compose\.lan-host\.yml/);
  });

  it("treats the production target as NOT development-only, and every Docker mode as development-only", () => {
    // This is the architectural direction encoded as data: Docker is a dev/CI environment, the
    // native service is what ships.
    expect(DEPLOYMENTS["native-linux"].developmentOnly).toBe(false);
    expect(DEPLOYMENTS["vm-bridged"].developmentOnly).toBe(false);
    for (const id of ["docker-bridge", "docker-host", "macvlan"] as const) {
      expect(DEPLOYMENTS[id].developmentOnly, id).toBe(true);
    }
  });

  it("flags the Docker Desktop platforms where a 'direct' claim silently does not hold", () => {
    // network_mode: host attaches to Docker Desktop's Linux VM, not the workstation — accepted
    // and inert. Only the deployments that can actually be run under Docker Desktop carry it.
    for (const id of ["docker-host", "macvlan"] as const) {
      expect(Object.keys(DEPLOYMENTS[id].unreliableLanAccessOn ?? {}).sort(), id).toEqual(["darwin", "win32"]);
    }
    for (const id of ["native-linux", "vm-bridged", "docker-bridge", "unknown"] as const) {
      expect(DEPLOYMENTS[id].unreliableLanAccessOn, id).toBeNull();
    }
  });

  it("never leaks Docker vocabulary into the production deployment's own description", () => {
    const native = DEPLOYMENTS["native-linux"];
    expect(`${native.label} ${native.noLanAccessRemedy ?? ""}`.toLowerCase()).not.toContain("docker");
  });
});
