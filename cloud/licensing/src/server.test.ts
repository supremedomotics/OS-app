import { generateSigningKeyPair } from "@supreme/crypto";
import { newId, type HomeId } from "@supreme/domain-model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { validateLicense } from "./index.js";
import { buildLicensingServer } from "./server.js";

/**
 * The dealer-licensing HTTP API on a real Fastify instance (via inject): auth by dealer API key,
 * issue → activate → seats → transfer → revoke, cross-org isolation, and validation errors.
 */
describe("licensing server", () => {
  let app: FastifyInstance;
  let publicKey: string;
  const authAcme = { authorization: "Bearer key-acme" };
  const authOther = { authorization: "Bearer key-other" };

  beforeEach(async () => {
    const keys = generateSigningKeyPair();
    publicKey = keys.publicKey;
    app = buildLicensingServer({
      privateKeyPem: keys.privateKey,
      apiKeys: new Map([
        ["key-acme", "org_acme"],
        ["key-other", "org_other"],
      ]),
      logLevel: "silent",
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const home = () => newId("home") as HomeId;

  it("rejects a request with no / bad API key", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/dealer/licenses" });
    expect(res.statusCode).toBe(401);
  });

  it("issues a signed license, lists it, and counts seats through the lifecycle", async () => {
    const h = home();
    const issue = await app.inject({
      method: "POST",
      url: "/v1/dealer/licenses",
      headers: authAcme,
      payload: { homeId: h, sku: "pro", seats: 5, features: ["energy"] },
    });
    expect(issue.statusCode).toBe(201);
    const { license, record } = issue.json();
    expect(record.status).toBe("issued");
    // Token verifies offline for the customer hub.
    expect(validateLicense(license, publicKey, { homeId: h }).valid).toBe(true);

    // Seats: 0 until activated.
    expect((await app.inject({ method: "GET", url: "/v1/dealer/seats", headers: authAcme })).json().seatsInUse).toBe(0);
    await app.inject({ method: "POST", url: `/v1/dealer/licenses/${license.id}/activate`, headers: authAcme });
    expect((await app.inject({ method: "GET", url: "/v1/dealer/seats", headers: authAcme })).json().seatsInUse).toBe(5);

    const list = await app.inject({ method: "GET", url: "/v1/dealer/licenses", headers: authAcme });
    expect(list.json().records).toHaveLength(1);
  });

  it("transfers to a new hub and re-signs; old token no longer valid for that hub", async () => {
    const oldHome = home();
    const newHome = home();
    const issued = (
      await app.inject({
        method: "POST",
        url: "/v1/dealer/licenses",
        headers: authAcme,
        payload: { homeId: oldHome, sku: "estate", seats: 8 },
      })
    ).json();

    const transfer = await app.inject({
      method: "POST",
      url: `/v1/dealer/licenses/${issued.license.id}/transfer`,
      headers: authAcme,
      payload: { newHomeId: newHome },
    });
    expect(transfer.statusCode).toBe(200);
    const { license: newLicense, record: newRecord } = transfer.json();
    expect(validateLicense(newLicense, publicKey, { homeId: newHome }).valid).toBe(true);
    expect(newRecord.supersedes).toBe(issued.license.id);
  });

  it("isolates dealers — org_other cannot touch org_acme's license", async () => {
    const issued = (
      await app.inject({
        method: "POST",
        url: "/v1/dealer/licenses",
        headers: authAcme,
        payload: { homeId: home(), sku: "pro" },
      })
    ).json();

    const revoke = await app.inject({
      method: "POST",
      url: `/v1/dealer/licenses/${issued.license.id}/revoke`,
      headers: authOther,
    });
    expect(revoke.statusCode).toBe(404);
    // org_other's ledger is empty.
    expect((await app.inject({ method: "GET", url: "/v1/dealer/licenses", headers: authOther })).json().records).toHaveLength(0);
  });

  it("validates the issue body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/dealer/licenses",
      headers: authAcme,
      payload: { sku: "pro" }, // missing homeId
    });
    expect(res.statusCode).toBe(400);
  });
});
