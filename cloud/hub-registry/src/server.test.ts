import {
  buildEnrollmentRequest,
  DevHubCA,
  generateHubIdentity,
  type Attestation,
} from "@supreme/hub-identity";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHubRegistryServer } from "./server.js";

const META = { model: "Hub Pro", fwVersion: "0.4.0" };
const ATTEST: Attestation = { kind: "factory", evidence: "sig" };

describe("Hub Registry HTTP server", () => {
  let app: FastifyInstance;
  let ca: DevHubCA;

  beforeEach(async () => {
    ca = DevHubCA.generate();
    app = buildHubRegistryServer({ ca, brokerEndpoint: "https://broker.test", logLevel: "silent" });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function enroll() {
    const id = generateHubIdentity();
    const req = buildEnrollmentRequest(id, META, ATTEST);
    const res = await app.inject({ method: "POST", url: "/v1/hubs/enroll", payload: req });
    return { id, res };
  }

  it("healthz", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(JSON.parse(res.payload).service).toBe("hub-registry");
  });

  it("enrolls a hub (201) and returns a broker endpoint", async () => {
    const { res } = await enroll();
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).brokerEndpoint).toBe("https://broker.test");
  });

  it("rejects a tampered enrollment request (422)", async () => {
    const id = generateHubIdentity();
    const req = { ...buildEnrollmentRequest(id, META, ATTEST), meta: { ...META, fwVersion: "9.9" } };
    const res = await app.inject({ method: "POST", url: "/v1/hubs/enroll", payload: req });
    expect(res.statusCode).toBe(422);
  });

  it("requires an account session to claim (401)", async () => {
    const { id } = await enroll();
    await app.inject({ method: "POST", url: `/v1/hubs/${id.hubUuid}/claim-code` });
    const res = await app.inject({
      method: "POST",
      url: `/v1/hubs/${id.hubUuid}/claim`,
      payload: { code: "X" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("claims with a code + account session (201)", async () => {
    const { id } = await enroll();
    const codeRes = await app.inject({ method: "POST", url: `/v1/hubs/${id.hubUuid}/claim-code` });
    const code = JSON.parse(codeRes.payload).code as string;
    const res = await app.inject({
      method: "POST",
      url: `/v1/hubs/${id.hubUuid}/claim`,
      headers: { "x-account-id": "acct-1" },
      payload: { code, homeName: "Villa" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).membership.role).toBe("owner");
  });
});
