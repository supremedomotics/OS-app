import { generateSigningKeyPair } from "@supreme/crypto";
import { newId, type HomeId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import {
  DealerLicensingError,
  DealerLicensingService,
  InMemoryLicenseRecordStore,
} from "./index.js";
import { validateLicense } from "./index.js";

const dealerOrgId = "dealer-acme";
const homeId = () => newId("home") as HomeId;

function makeService() {
  const { publicKey, privateKey } = generateSigningKeyPair();
  const store = new InMemoryLicenseRecordStore();
  const svc = new DealerLicensingService(store, privateKey);
  return { svc, store, publicKey, privateKey };
}

describe("dealer licensing", () => {
  it("issues a signed, hub-bound license and records it", async () => {
    const { svc, publicKey } = makeService();
    const home = homeId();
    const { license, record } = await svc.issue({
      dealerOrgId,
      homeId: home,
      sku: "pro",
      seats: 5,
      features: ["energy"],
    });

    // The token really verifies offline and is bound to the customer hub.
    const res = validateLicense(license, publicKey, { homeId: home });
    expect(res.valid).toBe(true);
    expect(record.status).toBe("issued");
    expect(record.dealerOrgId).toBe(dealerOrgId);
    expect(record.id).toBe(license.id);
  });

  it("tracks activation and counts seats in use", async () => {
    const { svc } = makeService();
    const a = await svc.issue({ dealerOrgId, homeId: homeId(), sku: "pro", seats: 3 });
    const b = await svc.issue({ dealerOrgId, homeId: homeId(), sku: "estate", seats: 10 });

    expect(await svc.seatsInUse(dealerOrgId)).toBe(0); // issued, not yet activated

    await svc.markActivated(a.license.id);
    expect(await svc.seatsInUse(dealerOrgId)).toBe(3);

    await svc.markActivated(b.license.id);
    expect(await svc.seatsInUse(dealerOrgId)).toBe(13);
  });

  it("revokes a license and frees its seats", async () => {
    const { svc } = makeService();
    const a = await svc.issue({ dealerOrgId, homeId: homeId(), sku: "pro", seats: 4 });
    await svc.markActivated(a.license.id);
    expect(await svc.seatsInUse(dealerOrgId)).toBe(4);

    const revoked = await svc.revoke(a.license.id);
    expect(revoked.status).toBe("revoked");
    expect(await svc.seatsInUse(dealerOrgId)).toBe(0);
  });

  it("cannot activate a revoked license", async () => {
    const { svc } = makeService();
    const a = await svc.issue({ dealerOrgId, homeId: homeId(), sku: "pro", seats: 1 });
    await svc.revoke(a.license.id);
    await expect(svc.markActivated(a.license.id)).rejects.toBeInstanceOf(DealerLicensingError);
  });

  it("transfers a license to a replacement hub, re-signing for the new home", async () => {
    const { svc, publicKey } = makeService();
    const oldHome = homeId();
    const newHome = homeId();
    const a = await svc.issue({
      dealerOrgId,
      homeId: oldHome,
      sku: "estate",
      seats: 8,
      features: ["cameras"],
    });

    const { license: newLicense, record: newRecord } = await svc.transfer(a.license.id, newHome);

    // New token is valid for the NEW hub and invalid for the old one.
    expect(validateLicense(newLicense, publicKey, { homeId: newHome }).valid).toBe(true);
    expect(validateLicense(newLicense, publicKey, { homeId: oldHome })).toEqual({
      valid: false,
      reason: "wrong_home",
    });
    expect(newRecord.supersedes).toBe(a.license.id);
    expect(newRecord.sku).toBe("estate");
    expect(newRecord.features).toEqual(["cameras"]);

    // Old record is marked transferred; history keeps both.
    const history = await svc.history(dealerOrgId);
    expect(history.map((r) => r.status).sort()).toEqual(["issued", "transferred"]);
  });

  it("throws for an unknown license id", async () => {
    const { svc } = makeService();
    await expect(svc.revoke("does-not-exist")).rejects.toBeInstanceOf(DealerLicensingError);
  });
});
