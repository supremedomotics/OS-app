import {
  buildEnrollmentRequest,
  DevHubCA,
  generateHubIdentity,
  signChallenge,
  type DeviceCredential,
  type HubIdentity,
} from "@supreme/hub-identity";
import { describe, expect, it, vi } from "vitest";
import { TunnelBroker, type BrokerSocket } from "./broker.js";

const META = { model: "Hub Pro", fwVersion: "0.4.0" };
const ATTEST = { kind: "factory" as const, evidence: "sig" };

function enrolledHub(ca: DevHubCA): { id: HubIdentity; cred: DeviceCredential } {
  const id = generateHubIdentity();
  const cred = ca.issue(buildEnrollmentRequest(id, META, ATTEST));
  return { id, cred };
}

/** A loopback socket that feeds whatever the broker sends back into a handler. */
function loopback(onSend: (data: string) => void): BrokerSocket {
  return { send: onSend };
}

describe("TunnelBroker — handshake (cert auth)", () => {
  it("accepts a hub that signs the challenge with its device key", () => {
    const ca = DevHubCA.generate();
    const broker = new TunnelBroker({ caPublicKey: ca.caPublicKey });
    const { id, cred } = enrolledHub(ca);

    const challenge = broker.issueChallenge();
    const sig = signChallenge(challenge, id.privateKey);
    const result = broker.verifyHandshake({ credential: cred, challengeSignature: sig }, challenge);
    expect(result.ok).toBe(true);
    expect(result.hubId).toBe(id.hubUuid);
  });

  it("rejects a hub that does not hold the matching device key", () => {
    const ca = DevHubCA.generate();
    const broker = new TunnelBroker({ caPublicKey: ca.caPublicKey });
    const { cred } = enrolledHub(ca);
    const attacker = generateHubIdentity();

    const challenge = broker.issueChallenge();
    const sig = signChallenge(challenge, attacker.privateKey); // wrong key
    expect(broker.verifyHandshake({ credential: cred, challengeSignature: sig }, challenge).ok).toBe(false);
  });

  it("rejects a credential signed by a different CA", () => {
    const ca = DevHubCA.generate();
    const broker = new TunnelBroker({ caPublicKey: ca.caPublicKey });
    const otherCa = DevHubCA.generate();
    const { id, cred } = enrolledHub(otherCa); // credential from an untrusted CA

    const challenge = broker.issueChallenge();
    const sig = signChallenge(challenge, id.privateKey);
    expect(broker.verifyHandshake({ credential: cred, challengeSignature: sig }, challenge).ok).toBe(false);
  });

  it("rejects a replayed signature against a fresh challenge", () => {
    const ca = DevHubCA.generate();
    const broker = new TunnelBroker({ caPublicKey: ca.caPublicKey });
    const { id, cred } = enrolledHub(ca);

    const oldChallenge = broker.issueChallenge();
    const sig = signChallenge(oldChallenge, id.privateKey);
    const freshChallenge = broker.issueChallenge();
    expect(broker.verifyHandshake({ credential: cred, challengeSignature: sig }, freshChallenge).ok).toBe(false);
  });
});

describe("TunnelBroker — forwarding", () => {
  it("forwards a request to the attached hub and resolves its response", async () => {
    const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
    // The hub echoes every request frame back as a 200 response.
    const detach = broker.attach("hub-1", loopback((data) => {
      const frame = JSON.parse(data) as { id: string; path: string };
      broker.handleMessage("hub-1", JSON.stringify({ t: "res", id: frame.id, status: 200, headers: {}, body: `ok:${frame.path}` }));
    }));

    const res = await broker.forward("hub-1", { method: "GET", path: "/v1/rooms", headers: {} });
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok:/v1/rooms");
    detach();
  });

  it("rejects forwarding to an offline hub", async () => {
    const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
    await expect(broker.forward("nope", { method: "GET", path: "/v1/rooms", headers: {} })).rejects.toThrow(/offline/);
  });

  it("times out if the hub never responds", async () => {
    vi.useFakeTimers();
    const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
    broker.attach("hub-1", loopback(() => {})); // black hole
    const p = broker.forward("hub-1", { method: "GET", path: "/v1/rooms", headers: {} }, 1000);
    const assertion = expect(p).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    vi.useRealTimers();
  });

  it("isolates hubs — a request for one hub never reaches another", async () => {
    const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
    const hubA = vi.fn();
    broker.attach("hub-A", loopback(hubA));
    broker.attach("hub-B", loopback((data) => {
      const frame = JSON.parse(data) as { id: string };
      broker.handleMessage("hub-B", JSON.stringify({ t: "res", id: frame.id, status: 200, headers: {}, body: "B" }));
    }));
    const res = await broker.forward("hub-B", { method: "GET", path: "/v1/x", headers: {} });
    expect(res.body).toBe("B");
    expect(hubA).not.toHaveBeenCalled(); // hub-A's socket was never used
  });

  it("supersedes an old connection on reconnect", async () => {
    const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
    broker.attach("hub-1", loopback(() => {}));
    const inflight = broker.forward("hub-1", { method: "GET", path: "/v1/x", headers: {} }, 5000);
    // Hub reconnects (new socket) — the old in-flight request is failed, not left hanging.
    broker.attach("hub-1", loopback(() => {}));
    await expect(inflight).rejects.toThrow(/superseded/);
  });
});
