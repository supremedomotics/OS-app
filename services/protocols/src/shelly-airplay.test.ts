import { createServer, type Server } from "node:http";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShellyProtocolDriver } from "./shelly-driver.js";
import { commandToShellyRpc, capabilitiesFromShellyStatus } from "./shelly-codec.js";
import { AirPlayProtocolDriver, type AirPlaySender, type AirPlaySenderState } from "./airplay-driver.js";
import type { MdnsService } from "./mdns.js";

/** An in-process Shelly Gen2 RPC device: a relay (switch:0) with power metering. */
function startShelly(): Promise<{ server: Server; base: string; calls: string[]; state: { on: boolean } }> {
  const calls: string[] = [];
  const state = { on: false };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const rpc = JSON.parse(body || "{}") as { id: number; method: string; params?: { on?: boolean } };
        calls.push(rpc.method);
        let result: unknown = {};
        if (rpc.method === "Switch.Set") {
          state.on = Boolean(rpc.params?.on);
          result = { was_on: !state.on };
        } else if (rpc.method === "Switch.Toggle") {
          state.on = !state.on;
        } else if (rpc.method === "Shelly.GetStatus") {
          result = { "switch:0": { output: state.on, apower: state.on ? 14.2 : 0 } };
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: rpc.id, result }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, calls, state });
    });
  });
}

describe("Shelly Gen2 driver (in-process RPC)", () => {
  let srv: Awaited<ReturnType<typeof startShelly>>;
  let driver: ShellyProtocolDriver;
  const dev = "device-shelly" as DeviceId;

  beforeAll(async () => {
    srv = await startShelly();
    driver = new ShellyProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: srv.base });
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((r) => srv.server.close(() => r()));
  });

  it("encodes RPC + infers capabilities from status", () => {
    expect(commandToShellyRpc({ capability: "onoff", action: "on" }, 0, null)).toEqual({
      method: "Switch.Set",
      params: { id: 0, on: true },
    });
    expect(capabilitiesFromShellyStatus({ "switch:0": { apower: 1 }, "cover:0": {} })).toEqual([
      "onoff",
      "position",
      "sensor",
    ]);
  });

  it("drives a relay over RPC and polls its status into onoff state", async () => {
    await driver.command(dev, { capability: "onoff", action: "on" });
    expect(srv.state.on).toBe(true);
    expect(srv.calls).toContain("Switch.Set");

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));
    await driver.poll();
    expect(events.at(-1)?.state).toEqual({ kind: "onoff", on: true });
  });

  it("discovers via mDNS and enriches capabilities from the device", async () => {
    const fake: MdnsService = {
      name: "shellyplus1-aabbcc._shelly._tcp.local",
      host: "shelly.local",
      port: 80,
      addresses: [srv.base.replace("http://", "")], // point discovery at our in-process device
      txt: { id: "shellyplus1-aabbcc" },
    };
    const d2 = new ShellyProtocolDriver({ pollMs: 1_000_000, mdns: async () => [fake] });
    await d2.connect();
    const found = await d2.discover();
    expect(found).toHaveLength(1);
    expect(found[0]?.capabilities).toContain("onoff");
    expect(found[0]?.capabilities).toContain("sensor"); // apower present
    expect(found[0]?.suggestedName).toContain("shellyplus1");
    await d2.disconnect();
  });
});

describe("AirPlay driver (discovery real, sender seam)", () => {
  it("discovers receivers over mDNS and maps media commands to the sender", async () => {
    let playing = false;
    let vol = 30;
    const sender: AirPlaySender = {
      start: async () => void (playing = true),
      stop: async () => void (playing = false),
      setVolume: async (v) => void (vol = v),
      getState: async (): Promise<AirPlaySenderState> => ({ playing, volume: vol }),
    };
    const fake: MdnsService = {
      name: "Office\\032HomePod._airplay._tcp.local",
      host: "homepod.local",
      port: 7000,
      addresses: ["10.0.0.77"],
      txt: { model: "AudioAccessory" },
    };
    const driver = new AirPlayProtocolDriver({ pollMs: 1_000_000, connect: async () => sender, mdns: async () => [fake] });
    await driver.connect();

    const found = await driver.discover();
    expect(found[0]).toMatchObject({ backendId: "10.0.0.77", capabilities: ["media"] });
    expect(found[0]?.suggestedName).toBe("Office HomePod");

    const dev = "device-airplay" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", address: "10.0.0.77" });
    await driver.command(dev, { capability: "media", action: "play" });
    await driver.command(dev, { capability: "media", action: "volume", volume: 55 });
    expect(vol).toBe(55);
    const s = driver.getState(dev, "media") as { playback: string; volume: number; source: string | null };
    expect(s.playback).toBe("playing");
    expect(s.volume).toBe(55);
    expect(s.source).toBe("AirPlay");
  });
});
