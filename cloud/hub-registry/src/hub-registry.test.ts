import {
  buildEnrollmentRequest,
  DevHubCA,
  generateHubIdentity,
  verifyDeviceCredential,
  type Attestation,
} from "@supreme/hub-identity";
import { describe, expect, it } from "vitest";
import { HubRegistry, InMemoryHubRegistryStore, RegistryError } from "./index.js";

const META = { model: "Supreme Hub Pro", fwVersion: "0.4.0" };
const ATTEST: Attestation = { kind: "factory", evidence: "factory-sig" };
const T0 = 1_750_000_000_000;

function fixedClock() {
  let t = T0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function setup() {
  const clock = fixedClock();
  const ca = DevHubCA.generate();
  const registry = new HubRegistry({ ca, now: clock.now, store: new InMemoryHubRegistryStore() });
  return { clock, ca, registry };
}

describe("HubRegistry — enrollment", () => {
  it("enrolls a hub zero-touch and issues a verifiable credential", () => {
    const { registry, ca } = setup();
    const id = generateHubIdentity(T0);
    const req = buildEnrollmentRequest(id, META, ATTEST, T0);

    const res = registry.enroll(req);
    expect(verifyDeviceCredential(res.credential, ca.caPublicKey, T0).valid).toBe(true);
    expect(res.brokerEndpoint).toContain("broker");

    const hub = registry.getHub(id.hubUuid);
    expect(hub?.status).toBe("provisioned");
    expect(hub?.claimedByAccountId).toBeNull();
  });

  it("rejects a replayed enrollment request (single-use nonce)", () => {
    const { registry } = setup();
    const id = generateHubIdentity(T0);
    const req = buildEnrollmentRequest(id, META, ATTEST, T0);
    registry.enroll(req);
    expect(() => registry.enroll(req)).toThrow(RegistryError);
  });

  it("refuses to bind a known hub uuid to a different device key (anti-hijack)", () => {
    const { registry } = setup();
    const id = generateHubIdentity(T0);
    registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));

    const attacker = { ...generateHubIdentity(T0), hubUuid: id.hubUuid };
    const forged = buildEnrollmentRequest(attacker, META, ATTEST, T0);
    expect(() => registry.enroll(forged)).toThrow(/different key/);
  });

  it("renews a credential for an enrolled hub proving key possession", () => {
    const { registry, clock, ca } = setup();
    const id = generateHubIdentity(T0);
    registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));
    clock.advance(60_000);
    const renewed = registry.renew(buildEnrollmentRequest(id, META, ATTEST, clock.now()));
    expect(verifyDeviceCredential(renewed.credential, ca.caPublicKey, clock.now()).valid).toBe(true);
  });
});

describe("HubRegistry — claiming", () => {
  it("claims a hub to an owner and creates home + owner membership", () => {
    const { registry } = setup();
    const id = generateHubIdentity(T0);
    registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));

    const code = registry.issueClaimCode(id.hubUuid);
    const { home, membership } = registry.claim(id.hubUuid, "acct-1", code.code, "Mumbai Villa");

    expect(home.name).toBe("Mumbai Villa");
    expect(home.ownerAccountId).toBe("acct-1");
    expect(membership.role).toBe("owner");
    expect(registry.getHub(id.hubUuid)?.status).toBe("claimed");
    expect(registry.listHubsForAccount("acct-1").map((h) => h.hubUuid)).toContain(id.hubUuid);
  });

  it("rejects a claim with a wrong code", () => {
    const { registry } = setup();
    const id = generateHubIdentity(T0);
    registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));
    registry.issueClaimCode(id.hubUuid);
    expect(() => registry.claim(id.hubUuid, "acct-1", "WRONGXXX")).toThrow(/invalid or expired/);
  });

  it("rejects a claim with an expired code", () => {
    const { registry, clock } = setup();
    const id = generateHubIdentity(T0);
    registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));
    const code = registry.issueClaimCode(id.hubUuid);
    clock.advance(11 * 60_000); // codes live 10 min
    expect(() => registry.claim(id.hubUuid, "acct-1", code.code)).toThrow(RegistryError);
  });

  it("won't double-claim a hub", () => {
    const { registry } = setup();
    const id = generateHubIdentity(T0);
    registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));
    const code = registry.issueClaimCode(id.hubUuid);
    registry.claim(id.hubUuid, "acct-1", code.code);
    expect(() => registry.issueClaimCode(id.hubUuid)).toThrow(/already claimed/);
  });

  it("supports one account claiming multiple hubs (multi-home)", () => {
    const { registry } = setup();
    for (const name of ["Villa", "Apartment", "Farmhouse"]) {
      const id = generateHubIdentity(T0);
      registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));
      const code = registry.issueClaimCode(id.hubUuid);
      registry.claim(id.hubUuid, "acct-1", code.code, name);
    }
    expect(registry.listHubsForAccount("acct-1")).toHaveLength(3);
  });
});

describe("HubRegistry — lifecycle", () => {
  it("tracks heartbeat presence and revocation", () => {
    const { registry, clock } = setup();
    const id = generateHubIdentity(T0);
    const res = registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));
    clock.advance(5000);
    registry.heartbeat(id.hubUuid);
    expect(registry.getHub(id.hubUuid)?.lastSeenAt).toBe(T0 + 5000);

    expect(registry.isRevoked(res.credential.serial)).toBe(false);
    registry.revoke(res.credential.serial);
    expect(registry.isRevoked(res.credential.serial)).toBe(true);
  });
});
