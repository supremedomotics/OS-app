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
  it("enrolls a hub zero-touch and issues a verifiable credential", async () => {
    const { registry, ca } = setup();
    const id = generateHubIdentity(T0);
    const req = buildEnrollmentRequest(id, META, ATTEST, T0);

    const res = await registry.enroll(req);
    expect(verifyDeviceCredential(res.credential, ca.caPublicKey, T0).valid).toBe(true);
    expect(res.brokerEndpoint).toContain("broker");

    const hub = await registry.getHub(id.hubUuid);
    expect(hub?.status).toBe("provisioned");
    expect(hub?.claimedByAccountId).toBeNull();
  });

  it("rejects a replayed enrollment request (single-use nonce)", async () => {
    const { registry } = setup();
    const id = generateHubIdentity(T0);
    const req = buildEnrollmentRequest(id, META, ATTEST, T0);
    await registry.enroll(req);
    await expect(registry.enroll(req)).rejects.toThrow(RegistryError);
  });

  it("refuses to bind a known hub uuid to a different device key (anti-hijack)", async () => {
    const { registry } = setup();
    const id = generateHubIdentity(T0);
    await registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));

    const attacker = { ...generateHubIdentity(T0), hubUuid: id.hubUuid };
    const forged = buildEnrollmentRequest(attacker, META, ATTEST, T0);
    await expect(registry.enroll(forged)).rejects.toThrow(/different key/);
  });

  it("renews a credential for an enrolled hub proving key possession", async () => {
    const { registry, clock, ca } = setup();
    const id = generateHubIdentity(T0);
    await registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));
    clock.advance(60_000);
    const renewed = await registry.renew(buildEnrollmentRequest(id, META, ATTEST, clock.now()));
    expect(verifyDeviceCredential(renewed.credential, ca.caPublicKey, clock.now()).valid).toBe(true);
  });
});

describe("HubRegistry — claiming", () => {
  it("claims a hub to an owner and creates home + owner membership", async () => {
    const { registry } = setup();
    const id = generateHubIdentity(T0);
    await registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));

    const code = await registry.issueClaimCode(id.hubUuid);
    const { home, membership } = await registry.claim(id.hubUuid, "acct-1", code.code, "Mumbai Villa");

    expect(home.name).toBe("Mumbai Villa");
    expect(home.ownerAccountId).toBe("acct-1");
    expect(membership.role).toBe("owner");
    expect((await registry.getHub(id.hubUuid))?.status).toBe("claimed");
    expect((await registry.listHubsForAccount("acct-1")).map((h) => h.hubUuid)).toContain(id.hubUuid);
  });

  it("rejects a claim with a wrong code", async () => {
    const { registry } = setup();
    const id = generateHubIdentity(T0);
    await registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));
    await registry.issueClaimCode(id.hubUuid);
    await expect(registry.claim(id.hubUuid, "acct-1", "WRONGXXX")).rejects.toThrow(/invalid or expired/);
  });

  it("rejects a claim with an expired code", async () => {
    const { registry, clock } = setup();
    const id = generateHubIdentity(T0);
    await registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));
    const code = await registry.issueClaimCode(id.hubUuid);
    clock.advance(11 * 60_000); // codes live 10 min
    await expect(registry.claim(id.hubUuid, "acct-1", code.code)).rejects.toThrow(RegistryError);
  });

  it("won't double-claim a hub", async () => {
    const { registry } = setup();
    const id = generateHubIdentity(T0);
    await registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));
    const code = await registry.issueClaimCode(id.hubUuid);
    await registry.claim(id.hubUuid, "acct-1", code.code);
    await expect(registry.issueClaimCode(id.hubUuid)).rejects.toThrow(/already claimed/);
  });

  it("supports one account claiming multiple hubs (multi-home)", async () => {
    const { registry } = setup();
    for (const name of ["Villa", "Apartment", "Farmhouse"]) {
      const id = generateHubIdentity(T0);
      await registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));
      const code = await registry.issueClaimCode(id.hubUuid);
      await registry.claim(id.hubUuid, "acct-1", code.code, name);
    }
    expect(await registry.listHubsForAccount("acct-1")).toHaveLength(3);
  });
});

describe("HubRegistry — lifecycle", () => {
  it("tracks heartbeat presence and revocation", async () => {
    const { registry, clock } = setup();
    const id = generateHubIdentity(T0);
    const res = await registry.enroll(buildEnrollmentRequest(id, META, ATTEST, T0));
    clock.advance(5000);
    await registry.heartbeat(id.hubUuid);
    expect((await registry.getHub(id.hubUuid))?.lastSeenAt).toBe(T0 + 5000);

    expect(await registry.isRevoked(res.credential.serial)).toBe(false);
    await registry.revoke(res.credential.serial);
    expect(await registry.isRevoked(res.credential.serial)).toBe(true);
  });
});
