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

  describe("getHubPublicKey (§Phase12) — retains the handshake-proven device key", () => {
    it("returns the device public key passed to attach()", () => {
      const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
      broker.attach("hub-1", loopback(() => {}), "pem-public-key-for-hub-1");
      expect(broker.getHubPublicKey("hub-1")).toBe("pem-public-key-for-hub-1");
    });

    it("returns undefined for a hub that was never attached", () => {
      const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
      expect(broker.getHubPublicKey("never-attached")).toBeUndefined();
    });

    it("returns undefined again after the hub detaches (offline hubs are never authorizable)", () => {
      const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
      const detach = broker.attach("hub-1", loopback(() => {}), "pem-key");
      expect(broker.getHubPublicKey("hub-1")).toBe("pem-key");
      detach();
      expect(broker.getHubPublicKey("hub-1")).toBeUndefined();
    });

    it("updates to the NEW connection's key on reconnect, not the stale one", () => {
      const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
      broker.attach("hub-1", loopback(() => {}), "old-key");
      broker.attach("hub-1", loopback(() => {}), "new-key");
      expect(broker.getHubPublicKey("hub-1")).toBe("new-key");
    });
  });
});

describe("TunnelBroker — stream multiplexing (§Phase12.9)", () => {
  it("returns null for an offline hub — never fabricates a stream", () => {
    const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
    expect(broker.openStream("nope", "/v1/stream", { onData: () => {}, onClose: () => {} })).toBeNull();
  });

  it("sends a real stream_open frame on the hub's existing tunnel socket, then relays data both ways", () => {
    const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
    const sent: unknown[] = [];
    broker.attach("hub-1", loopback((d) => sent.push(JSON.parse(d))));

    const received: string[] = [];
    const handle = broker.openStream("hub-1", "/v1/stream?access_token=tok", {
      onData: (d) => received.push(d),
      onClose: () => {},
    });
    expect(handle).not.toBeNull();
    expect(sent[0]).toMatchObject({ t: "stream_open", path: "/v1/stream?access_token=tok" });

    // Hub → broker: a live frame arrives.
    broker.handleMessage("hub-1", JSON.stringify({ t: "stream_data", id: handle!.id, data: '{"type":"state"}' }));
    expect(received).toEqual(['{"type":"state"}']);

    // Broker → hub: the client sends a frame (e.g. a subscribe).
    handle!.send('{"type":"subscribe"}');
    expect(sent[1]).toEqual({ t: "stream_data", id: handle!.id, data: '{"type":"subscribe"}' });
  });

  it("client-initiated close sends stream_close and stops delivering further data", () => {
    const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
    const sent: unknown[] = [];
    broker.attach("hub-1", loopback((d) => sent.push(JSON.parse(d))));
    const received: string[] = [];
    const handle = broker.openStream("hub-1", "/v1/stream", { onData: (d) => received.push(d), onClose: () => {} })!;

    handle.close();
    expect(sent.at(-1)).toEqual({ t: "stream_close", id: handle.id });

    // A late frame from the hub for the now-closed stream id is dropped, not delivered.
    broker.handleMessage("hub-1", JSON.stringify({ t: "stream_data", id: handle.id, data: "late" }));
    expect(received).toEqual([]);
  });

  it("hub-initiated stream_close is delivered to the client as onClose", () => {
    const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
    broker.attach("hub-1", loopback(() => {}));
    let closedWith: [number | undefined, string | undefined] | null = null;
    const handle = broker.openStream("hub-1", "/v1/stream", {
      onData: () => {},
      onClose: (code, reason) => { closedWith = [code, reason]; },
    })!;

    broker.handleMessage("hub-1", JSON.stringify({ t: "stream_close", id: handle.id, code: 1000, reason: "done" }));
    expect(closedWith).toEqual([1000, "done"]);
  });

  it("isolates streams — a frame for hub-A's stream never reaches hub-B's handler", () => {
    const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
    broker.attach("hub-A", loopback(() => {}));
    broker.attach("hub-B", loopback(() => {}));
    const a: string[] = [];
    const b: string[] = [];
    const handleA = broker.openStream("hub-A", "/v1/stream", { onData: (d) => a.push(d), onClose: () => {} })!;
    broker.openStream("hub-B", "/v1/stream", { onData: (d) => b.push(d), onClose: () => {} });

    broker.handleMessage("hub-A", JSON.stringify({ t: "stream_data", id: handleA.id, data: "for-A" }));
    // hub-B's handleMessage can never reference hub-A's stream id (different Conn's map).
    broker.handleMessage("hub-B", JSON.stringify({ t: "stream_data", id: handleA.id, data: "leak-attempt" }));

    expect(a).toEqual(["for-A"]);
    expect(b).toEqual([]);
  });

  it("a hub reconnect (new tunnel socket) terminates its in-flight streams, not the other hub's", () => {
    const broker = new TunnelBroker({ caPublicKey: DevHubCA.generate().caPublicKey });
    broker.attach("hub-1", loopback(() => {}));
    let closed = false;
    broker.openStream("hub-1", "/v1/stream", { onData: () => {}, onClose: () => { closed = true; } });

    broker.attach("hub-1", loopback(() => {})); // reconnect
    expect(closed).toBe(true);
  });
});
