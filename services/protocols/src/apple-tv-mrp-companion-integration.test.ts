import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Server } from "node:net";
import type { DeviceId } from "@supreme/domain-model";
import { createDriverSecretCrypto } from "@supreme/drivers";
import { FakeMrpAppleTv } from "./apple-tv-mrp-client.test.js";
import { FakeCompanionAppleTv } from "./apple-tv-companion-client.test.js";
import { pairAppleTvMrp, createMrpAppleTvConnect } from "./apple-tv-mrp-client.js";
import { pairAppleTvCompanion } from "./apple-tv-companion-client.js";
import { createAppleTvCredentialStore, createInMemoryCredentialKv } from "./apple-tv-credential-store.js";
import { discoverCompanionAddress } from "./apple-tv-companion-discovery.js";
import type { MdnsService } from "./mdns.js";

function realSecretCrypto() {
  return createDriverSecretCrypto(randomBytes(32).toString("base64"));
}

/** Sets up one fully-paired Apple TV (MRP + Companion) and returns a ready `connect`
 * closure plus both fake peers, for scenario tests below. */
async function setupPairedDevice(deviceId: DeviceId) {
  const mrpTv = new FakeMrpAppleTv();
  const companionTv = new FakeCompanionAppleTv();
  const { server: mrpServer, port: mrpPort } = await mrpTv.start();
  const { server: companionServer, port: companionPort } = await companionTv.start();

  const mrpCredentialStore = createAppleTvCredentialStore(realSecretCrypto(), createInMemoryCredentialKv());
  const companionCredentialStore = createAppleTvCredentialStore(realSecretCrypto(), createInMemoryCredentialKv());
  const mrpAddress = `127.0.0.1:${mrpPort}`;
  const companionAddress = `127.0.0.1:${companionPort}`;

  await pairAppleTvMrp(mrpAddress, deviceId, mrpTv.pin, { credentialStore: mrpCredentialStore, hubIdentifier: "H", hubName: "Hub" });
  await pairAppleTvCompanion(companionAddress, deviceId, companionTv.pin, { credentialStore: companionCredentialStore });

  const clientOpts = {
    credentialStore: mrpCredentialStore,
    hubIdentifier: "H",
    hubName: "Hub",
    companion: {
      credentialStore: companionCredentialStore,
      addressFor: () => companionAddress, // explicit seam — bypasses real mDNS in tests
      reconnectBaseMs: 20,
      reconnectMaxMs: 100,
    },
  };

  return { mrpTv, companionTv, mrpServer, companionServer, mrpAddress, companionAddress, clientOpts };
}

describe("Apple TV MRP + Companion integration (§ Phase 3.1 — app registry recovery scenarios)", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it("Scenario A — normal connection: connect, discover apps, registry populated", async () => {
    const { mrpTv, companionTv, mrpServer, companionServer, mrpAddress, clientOpts } = await setupPairedDevice("appletv-scenario-a" as DeviceId);
    servers.push(mrpServer, companionServer);

    const client = await createMrpAppleTvConnect(clientOpts)({ address: mrpAddress, deviceId: "appletv-scenario-a" as DeviceId });
    const apps = await client.getApplications!();
    expect(apps.map((a) => a.packageName).sort()).toEqual(["com.google.ios.youtube", "com.netflix.Netflix"]);
    await client.close?.();
  });

  it("Scenario B — current app: connect, receive current-app event, TvForegroundApp updated", async () => {
    const { mrpTv, companionTv, mrpServer, companionServer, mrpAddress, clientOpts } = await setupPairedDevice("appletv-scenario-b" as DeviceId);
    servers.push(mrpServer, companionServer);

    const client = await createMrpAppleTvConnect(clientOpts)({ address: mrpAddress, deviceId: "appletv-scenario-b" as DeviceId });
    expect(await client.getCurrentApplication!()).toBeNull();
    mrpTv.pushCurrentApp("com.netflix.Netflix", "Netflix");
    await new Promise((r) => setTimeout(r, 20));
    expect((await client.getCurrentApplication!())?.packageName).toBe("com.netflix.Netflix");
    await client.close?.();
  });

  it("Scenario C — connection loss: apps already discovered, current app known, then the connection is lost", async () => {
    const { mrpTv, companionTv, mrpServer, companionServer, mrpAddress, clientOpts } = await setupPairedDevice("appletv-scenario-c" as DeviceId);
    servers.push(companionServer);

    const client = await createMrpAppleTvConnect(clientOpts)({ address: mrpAddress, deviceId: "appletv-scenario-c" as DeviceId });
    const apps = await client.getApplications!();
    expect(apps.length).toBe(2);
    mrpTv.pushCurrentApp("com.netflix.Netflix", "Netflix");
    await new Promise((r) => setTimeout(r, 20));
    expect((await client.getCurrentApplication!())?.packageName).toBe("com.netflix.Netflix");

    // Simulate connection loss: close the MRP server out from under the client.
    mrpServer.close();
    await client.close?.(); // test-side cleanup; the driver's own reconnect loop owns real recovery
  });

  it("Scenario D — Companion-only disconnect self-heals WITHOUT touching the healthy MRP connection", async () => {
    const { mrpTv, companionTv, mrpServer, companionServer, mrpAddress, companionAddress, clientOpts } = await setupPairedDevice(
      "appletv-scenario-d" as DeviceId,
    );
    servers.push(mrpServer);

    const deviceId = "appletv-scenario-d" as DeviceId;
    const client = await createMrpAppleTvConnect(clientOpts)({ address: mrpAddress, deviceId });
    expect(await client.getApplications!()).toHaveLength(2);

    // Kill ONLY the Companion server/connection — MRP must remain untouched. Closing
    // the listening socket alone doesn't sever an already-open connection, so also
    // destroy the sockets `server.close()` won't touch.
    companionServer.close();
    companionTv.destroyAllConnections();
    await new Promise((r) => setTimeout(r, 100));
    // getApplications is now gone (Companion session dropped) — never a stale/fabricated list.
    expect(client.getApplications).toBeUndefined();

    // MRP itself must still be fully functional throughout.
    await client.play();
    await new Promise((r) => setTimeout(r, 20));
    expect(mrpTv.receivedCommands.length).toBeGreaterThan(0);

    // Bring a NEW Companion server up on the SAME port, reusing the ORIGINAL device's
    // long-term identity (same physical Apple TV coming back — a different key would
    // correctly fail pair-verify) and its already-registered controller.
    const freshCompanionTv = new FakeCompanionAppleTv(companionTv);
    freshCompanionTv.knownControllers = companionTv.knownControllers;
    const port = Number(companionAddress.split(":")[1]);
    const { server: newServer } = await freshCompanionTv.start(port);
    servers.push(newServer);

    // Poll (bounded) rather than a single fixed sleep — real socket rebind timing on
    // some platforms (e.g. port release) is not perfectly deterministic.
    const deadline = Date.now() + 5000;
    while (!client.getApplications && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(client.getApplications).toBeDefined();
    const apps = await client.getApplications!();
    expect(apps.length).toBe(2);
    await client.close?.();
  });

  it("multi-instance stress: two fully independent Apple TVs share nothing (credentials, apps, current app, launches)", async () => {
    const a = await setupPairedDevice("appletv-stress-a" as DeviceId);
    const b = await setupPairedDevice("appletv-stress-b" as DeviceId);
    servers.push(a.mrpServer, a.companionServer, b.mrpServer, b.companionServer);
    a.companionTv.apps = { "com.netflix.Netflix": "Netflix" };
    b.companionTv.apps = { "com.spotify.client": "Spotify" };

    const clientA = await createMrpAppleTvConnect(a.clientOpts)({ address: a.mrpAddress, deviceId: "appletv-stress-a" as DeviceId });
    const clientB = await createMrpAppleTvConnect(b.clientOpts)({ address: b.mrpAddress, deviceId: "appletv-stress-b" as DeviceId });

    a.mrpTv.pushCurrentApp("com.netflix.Netflix", "Netflix");
    b.mrpTv.pushCurrentApp("com.spotify.client", "Spotify");
    await new Promise((r) => setTimeout(r, 20));

    expect((await clientA.getCurrentApplication!())?.packageName).toBe("com.netflix.Netflix");
    expect((await clientB.getCurrentApplication!())?.packageName).toBe("com.spotify.client");
    expect((await clientA.getApplications!()).map((x) => x.packageName)).toEqual(["com.netflix.Netflix"]);
    expect((await clientB.getApplications!()).map((x) => x.packageName)).toEqual(["com.spotify.client"]);

    await clientA.launchApplication!("com.netflix.Netflix");
    expect(a.companionTv.receivedLaunches.length).toBe(1);
    expect(b.companionTv.receivedLaunches.length).toBe(0);

    // Changing A's current app must never affect B's.
    a.mrpTv.pushCurrentApp("com.apple.tv", "Apple TV");
    await new Promise((r) => setTimeout(r, 20));
    expect((await clientA.getCurrentApplication!())?.packageName).toBe("com.apple.tv");
    expect((await clientB.getCurrentApplication!())?.packageName).toBe("com.spotify.client");

    await clientA.close?.();
    await clientB.close?.();
  });

  it("discoverCompanionAddress finds the right host among multiple advertised Apple TVs (real mDNS matching, fake browse)", async () => {
    const browse = async (): Promise<MdnsService[]> => [
      { name: "Living Room._companion-link._tcp.local", host: "10.0.0.5", port: 5001, addresses: ["10.0.0.5"], txt: {} },
      { name: "Theater._companion-link._tcp.local", host: "10.0.0.9", port: 5002, addresses: ["10.0.0.9"], txt: {} },
    ];
    expect(await discoverCompanionAddress("10.0.0.9", browse)).toBe("10.0.0.9:5002");
  });
});
