import { describe, expect, it } from "vitest";
import { diagnoseRouting, ipInCidr } from "./routing-diagnosis.js";
import { DEPLOYMENTS } from "./deployment.js";

describe("ipInCidr", () => {
  it("matches an address inside a /16 and rejects one outside it", () => {
    expect(ipInCidr("172.18.0.5", "172.18.0.2/16")).toBe(true);
    expect(ipInCidr("192.168.0.45", "172.18.0.2/16")).toBe(false);
  });

  it("matches a real home-LAN /24 correctly — the actual Casambi case", () => {
    expect(ipInCidr("192.168.0.45", "192.168.0.10/24")).toBe(true);
    expect(ipInCidr("192.168.1.45", "192.168.0.10/24")).toBe(false);
  });

  it("rejects malformed input rather than guessing", () => {
    expect(ipInCidr("not-an-ip", "192.168.0.0/24")).toBe(false);
    expect(ipInCidr("192.168.0.1", "garbage")).toBe(false);
    expect(ipInCidr("192.168.0.1", "192.168.0.0/99")).toBe(false);
  });
});

describe("diagnoseRouting", () => {
  it("classifies ENETUNREACH as 'no_route' and surfaces the deployment-specific remedy", () => {
    const d = diagnoseRouting({ destination: "192.168.0.45", errorCode: "ENETUNREACH", deployment: DEPLOYMENTS["docker-bridge"] });
    expect(d.verdict).toBe("no_route");
    expect(d.errorCode).toBe("ENETUNREACH");
    expect(d.destination).toBe("192.168.0.45");
    expect(d.explanation).toMatch(/rejected the send before any packet left the process/);
    // The decisive, actionable part: names the real root cause and the documented fix.
    // Remediation text now lives in deployment.ts (the one module allowed to know what Docker
    // is) — the diagnosis just surfaces it, which is exactly the isolation this asserts.
    expect(d.suggestedFix).toMatch(/docker-compose\.lan-host\.yml/);
    expect(d.suggestedFix).toMatch(/development-environment limitation, not a SupremeOS defect/);
  });

  it("classifies EHOSTUNREACH as a gateway problem, NOT a routing/deployment one", () => {
    const d = diagnoseRouting({ destination: "192.168.0.45", errorCode: "EHOSTUNREACH", deployment: DEPLOYMENTS["docker-host"] });
    expect(d.verdict).toBe("host_unreachable");
    expect(d.explanation).toMatch(/route to .* exists/);
    expect(d.suggestedFix).toMatch(/gateway\/addressing issue, not a SupremeOS or routing issue/);
  });

  it("classifies EACCES as a permission/broadcast-flag problem", () => {
    const d = diagnoseRouting({ destination: "255.255.255.255", errorCode: "EACCES", deployment: DEPLOYMENTS["docker-host"] });
    expect(d.verdict).toBe("permission_denied");
    expect(d.suggestedFix).toMatch(/SO_BROADCAST|broadcast: true/);
  });

  it("reports 'ok' with no suggested fix when there was no error", () => {
    const d = diagnoseRouting({ destination: "192.168.0.45", errorCode: null, deployment: DEPLOYMENTS["docker-host"] });
    expect(d.verdict).toBe("ok");
    expect(d.suggestedFix).toBeNull();
  });

  it("does not pretend to know an unrecognized errno's cause", () => {
    const d = diagnoseRouting({ destination: "192.168.0.45", errorCode: "EWEIRD", deployment: DEPLOYMENTS["docker-bridge"] });
    expect(d.verdict).toBe("unknown_error");
    expect(d.suggestedFix).toBeNull();
    expect(d.explanation).toMatch(/not one of the routing errors this diagnosis recognizes/);
  });

  it("always reports the REAL observable facts: platform, configured mode, and real interfaces", () => {
    const d = diagnoseRouting({ destination: "192.168.0.45", errorCode: "ENETUNREACH", deployment: DEPLOYMENTS["docker-bridge"] });
    expect(d.platform).toBe(process.platform);
    expect(d.deployment.id).toBe("docker-bridge");
    // This sandbox always has at least loopback; the shape is what matters.
    expect(Array.isArray(d.interfaces)).toBe(true);
    expect(d.interfaces.some((i) => i.internal && i.address === "127.0.0.1")).toBe(true);
  });

  // § Production Architecture Direction — the diagnosis appends a platform caveat from the
  // deployment table verbatim; it does not itself know which runtimes are affected or why.
  it("appends a deployment's platform caveat when the running platform is one it does not hold on", () => {
    const claimsDirectButLies = {
      ...DEPLOYMENTS["docker-host"],
      unreliableLanAccessOn: { [process.platform]: "the claim does not hold on this platform." },
    };
    const d = diagnoseRouting({ destination: "192.168.0.45", errorCode: "ENETUNREACH", deployment: claimsDirectButLies });
    expect(d.explanation).toContain("the claim does not hold on this platform.");
  });

  it("adds no caveat for a deployment whose LAN access claim holds everywhere", () => {
    const d = diagnoseRouting({ destination: "192.168.0.45", errorCode: "ENETUNREACH", deployment: DEPLOYMENTS["native-linux"] });
    expect(d.explanation).not.toContain("NOTE:");
  });

  it("reports outboundInterface as null when no local interface shares the destination's subnet — the key ENETUNREACH finding", () => {
    // 203.0.113.x is TEST-NET-3 (RFC 5737) — guaranteed not to be a local subnet anywhere.
    const d = diagnoseRouting({ destination: "203.0.113.7", errorCode: "ENETUNREACH", deployment: DEPLOYMENTS["docker-bridge"] });
    expect(d.outboundInterface).toBeNull();
    expect(d.explanation).toMatch(/No local interface is on .* subnet/);
  });
});
