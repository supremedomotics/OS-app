import { parseEtsProject, type KnxProjectModel } from "@supreme/commissioning";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGroupAddress, parseIndividualAddress } from "../native/address.js";
import { CemiMessageCode, decodeCemi } from "../native/cemi.js";
import { decodeFrame, decodeTunnellingRequest, ServiceType } from "../native/knxnetip-frame.js";
import { ManualClock, VirtualActuator, VirtualKnxBus, VirtualKnxInterface, VirtualNetwork, VirtualSender } from "../native/simulator/index.js";
import type { KnxDatagramSocket, SocketFactory, SocketHandlers } from "../native/transport.js";
import { KnxTunnelClient } from "../native/tunnel-client.js";
import { etsDevicesFromModel, type EtsDeviceInfo } from "./ets-registry.js";
import { DEFAULT_HEALTH_CONFIG as C, type HealthConfig } from "./health-model.js";
import { KnxHealthService } from "./health-service.js";

/**
 * VERTICAL SLICE, SIMULATOR ONLY: real ETS parser → ETS registrations → ConnectionManager-supervised native tunnel client → health monitor →
 * diagnostics, against a simulated KNX/IP interface and line. Proves the integration logic, not behaviour on real gateways or devices.
 */
const GW = "10.0.0.2";
const GA = (s: string) => parseGroupAddress(s);
const IA = (s: string) => parseIndividualAddress(s);
const HCFG: Partial<HealthConfig> = {
  checkIntervalMs: 60_000, passiveFreshnessMs: 180_000, activeFreshnessMs: 300_000, offlineMinSilenceMs: 300_000, failureRecheckMs: 20_000,
  offlineProbeIntervalMs: 120_000, responseTimeoutMs: 3_000, retryDelayMs: 1_000, slowResponseMs: 1_500, busFreshnessMs: 120_000,
};
const TUNNEL = { heartbeatIntervalMs: 20_000, heartbeatTimeoutMs: 2_000, heartbeatMaxFailures: 2, connectTimeoutMs: 5_000 };

// ---- ETS fixture ---------------------------------------------------------------------------------------------------------------------
interface Obj { n: number; text: string; r?: boolean; t?: boolean; w?: boolean; c?: boolean; send?: string[]; recv?: string[] }
interface Dev { id: string; name: string; addr?: string; objs: Obj[] }
const GAS = ["1/0/1", "1/1/1", "1/1/2", "1/1/20", "1/1/21", "1/1/3", "1/1/4", "1/1/5", "1/1/6", "1/1/60", "1/1/12", "2/0/1", "1/1/40", "1/1/41"];
const en = (b: boolean | undefined, d = false) => ((b ?? d) ? "Enabled" : "Disabled");
function xml(devs: Dev[]): string {
  const gas = GAS.map((a) => `<GroupAddress Id="GA-${a.replace(/\//g, "-")}" Address="${a}" Name="GA ${a}" DatapointType="DPST-1-1" />`).join("");
  const dis = devs.map((d) => `<DeviceInstance Id="${d.id}" Name="${d.name}" ${d.addr ? `Address="${d.addr}"` : ""} ProductRefId="M-01_H-1_P-1"><ComObjectInstanceRefs>${d.objs.map((o) =>
    `<ComObjectInstanceRef RefId="${d.id}_O-${o.n}" Text="${o.text}" Number="${o.n}" DatapointType="DPST-1-1" ReadFlag="${en(o.r)}" WriteFlag="${en(o.w)}" CommunicationFlag="${en(o.c, true)}" TransmitFlag="${en(o.t)}" UpdateFlag="Disabled"><Connectors>${
      (o.send ?? []).map((g) => `<Send GroupAddressRefId="GA-${g.replace(/\//g, "-")}" />`).join("")}${(o.recv ?? []).map((g) => `<Receive GroupAddressRefId="GA-${g.replace(/\//g, "-")}" />`).join("")}</Connectors></ComObjectInstanceRef>`).join("")}</ComObjectInstanceRefs></DeviceInstance>`).join("");
  return `<KNX><GroupAddresses><GroupRange Name="All">${gas}</GroupRange></GroupAddresses><Topology><Area Address="1"><Line Address="1">${dis}</Line></Area></Topology></KNX>`;
}
const model = (devs: Dev[]): KnxProjectModel => parseEtsProject(new Map([["P-0001/0.xml", Buffer.from(xml(devs), "utf8")]]));
const BASE: Dev[] = [
  { id: "A", name: "Actuator A", addr: "1", objs: [{ n: 1, text: "Switch", w: true, send: ["1/0/1"] }, { n: 2, text: "Switch Status", r: true, t: true, send: ["1/1/1"], recv: ["1/1/1"] }] },
  { id: "B", name: "Dimmer B", addr: "2", objs: [{ n: 1, text: "Status", r: true, t: true, send: ["1/1/2"] }, { n: 2, text: "Status 2", r: true, send: ["1/1/20"] }, { n: 3, text: "Status 3", r: true, send: ["1/1/21"] }] },
  { id: "C", name: "Blind C (never answers reads)", addr: "3", objs: [{ n: 1, text: "Position Status", r: true, t: true, send: ["1/1/3"] }] },
  { id: "D", name: "Sensor D (intermittent)", addr: "4", objs: [{ n: 1, text: "Value", r: true, t: true, send: ["1/1/4"] }] },
  { id: "E", name: "NoSend E", addr: "5", objs: [{ n: 1, text: "Listen only", r: true, recv: ["1/1/5"] }] },
  { id: "F", name: "Ambiguous F", addr: "6", objs: [{ n: 1, text: "Two senders", r: true, send: ["1/1/6", "1/1/60"] }] },
  { id: "G", name: "NoAddress G", objs: [{ n: 1, text: "Status", r: true, send: ["1/1/40"] }] },
  { id: "H", name: "Dup H", addr: "9", objs: [{ n: 1, text: "Status", r: true, send: ["1/1/41"] }] },
  { id: "I", name: "Dup I", addr: "9", objs: [{ n: 1, text: "Status", r: true, send: ["1/1/41"] }] },
  { id: "K", name: "Wall switch K", addr: "11", objs: [{ n: 1, text: "Switch", t: true, send: ["2/0/1"] }] },
  { id: "L", name: "Secure L", addr: "12", objs: [{ n: 1, text: "Status", r: true, t: true, send: ["1/1/12"] }] },
];

// ---- world ---------------------------------------------------------------------------------------------------------------------------
let clock: ManualClock; let net: VirtualNetwork; let bus: VirtualKnxBus; let iface: VirtualKnxInterface; let svc: KnxHealthService;
let frames: Array<{ t: number; frame: Buffer }>; let tunnels: KnxTunnelClient[]; const act: Record<string, VirtualActuator> = {}; let wall: VirtualSender; let talking = false;

function logged(inner: SocketFactory): SocketFactory {
  return async (h: SocketHandlers) => {
    const s = await inner(h);
    const w: KnxDatagramSocket = { get localPort() { return s.localPort; }, send: (d, p, a) => { frames.push({ t: clock.now(), frame: Buffer.from(d) }); s.send(d, p, a); }, close: () => s.close() };
    return w;
  };
}
function actuator(name: string, ia: string, status: string): VirtualActuator {
  const a = new VirtualActuator({ individualAddress: IA(ia), commandGa: GA("1/0/1"), feedbackGa: GA(status), dpt: "1.001", initial: false }, clock);
  bus.addDevice(a); act[name] = a; return a;
}
function makeService(over: Partial<HealthConfig> = {}): KnxHealthService {
  return new KnxHealthService({
    clock, gateway: { host: GW },
    createTunnel: () => { const t = new KnxTunnelClient({ host: GW, socketFactory: logged(net.createSocketFactory("10.0.0.50")), clock, ...TUNNEL }); tunnels.push(t); return t; },
    health: { ...HCFG, ...over }, reconnect: { minBackoffMs: 2_000, maxBackoffMs: 20_000, random: () => 0.5 },
  });
}
const SECURE = new Set(["L"]);
const dev = (id: string) => svc.snapshot().devices.find((d) => d.deviceId === id)!;
const diag = (id: string) => svc.diagnostics().devices.find((d) => d.deviceId === id)!;
const st = (id: string) => `${dev(id).state}/${dev(id).reason}`;
const readsSent = () => frames.flatMap((f) => {
  try { const d = decodeFrame(f.frame); if (d.service !== ServiceType.TUNNELLING_REQUEST) return []; const c = decodeCemi(decodeTunnellingRequest(d.body).cemi); return [{ t: f.t, c }]; } catch { return []; }
});

beforeEach(() => {
  clock = new ManualClock(); net = new VirtualNetwork(clock, 1); bus = new VirtualKnxBus(clock); frames = []; tunnels = []; talking = false;
  for (const k of Object.keys(act)) delete act[k];
  iface = new VirtualKnxInterface(net, bus, clock, { address: GW });
  actuator("A", "1.1.1", "1/1/1"); actuator("B", "1.1.2", "1/1/2");
  actuator("C", "1.1.3", "1/1/3").faults = { noFeedback: true };
  actuator("D", "1.1.4", "1/1/4").faults = { readResponsePattern: [true, false, false] };
  actuator("L", "1.1.12", "1/1/12");
  wall = new VirtualSender(IA("1.1.11")); bus.addDevice(wall);
  svc = makeService();
});
afterEach(async () => {
  talking = false;
  await svc.stop();
  await clock.advance(120_000);
  iface.shutdown();
  expect(clock.pendingTimers).toBe(0);
  expect(net.openClientSockets).toBe(0);
});
const startTalking = (): void => { talking = true; clock.setTimeout(function again() { if (!talking) return; wall.emit(bus, GA("2/0/1"), "1.001", true); clock.setTimeout(again, 90_000); }, 1_000); };
/** ConnectionManager.start() resolves after the first connect attempt; with a manual clock the attempt needs virtual time to pass. */
async function startSvc(): Promise<void> { const p = svc.start(); await clock.advance(50); await p; }
async function boot(devs: Dev[] = BASE) {
  const report = svc.importEts(etsDevicesFromModel(model(devs)), { secureDeviceIds: SECURE });
  await startSvc();
  return report;
}

describe("ETS import → registrations", () => {
  it("registers eligible devices and ONLY readable single-send status objects; everything else is reported with a reason", async () => {
    const r = await boot();
    expect(r.added.sort()).toEqual(["A", "B", "C", "D", "E", "F", "K", "L"]);
    expect(r.skipped.map((s) => `${s.deviceId}:${s.code}`).sort()).toEqual(["G:missing_individual_address", "H:duplicate_individual_address", "I:duplicate_individual_address"].sort());
    const codes = (id: string) => r.issues.filter((i) => i.deviceId === id).map((i) => i.code);
    expect(codes("E")).toContain("read_object_without_send_group");
    expect(codes("F")).toContain("ambiguous_send_group");
    expect(codes("B")).toContain("extra_status_objects_unused");
    expect(codes("L")).toContain("secure_device_not_probed");
    expect(codes("K")).toContain("no_readable_status_object");
    const reg = (id: string) => svc.monitor.registeredDevices().find((d) => d.deviceId === id)!;
    expect(reg("A").statusGroups).toEqual([GA("1/1/1")]);                              // the Switch (write-only) object is NOT a status group
    expect(reg("B").statusGroups).toEqual([GA("1/1/2"), GA("1/1/20")]);                // capped at 2, deterministic order
    expect(reg("E").statusGroups).toEqual([]); expect(reg("F").statusGroups).toEqual([]);
    expect(reg("L")).toMatchObject({ statusGroups: [], activeCheck: "disabled" });
    expect(svc.monitor.registeredDevices().some((d) => ["G", "H", "I"].includes(d.deviceId))).toBe(false);
  });
  it("keeps the ETS configuration (flags, object texts, DPT, group addresses, per-object decision) separate from evidence and shows it in diagnostics", async () => {
    await boot();
    const cfg = diag("A").configuration!.objects;
    const status = cfg.find((o) => o.text === "Switch Status")!;
    expect(status).toMatchObject({ eligible: true, reason: "read_enabled_single_send_group", dpt: "1.001", sendGroupAddresses: ["1/1/1"] });
    expect(status.flags).toMatchObject({ read: true, transmit: true, communicate: true, write: false });
    expect(cfg.find((o) => o.text === "Switch")).toMatchObject({ eligible: false, reason: "read_flag_not_enabled" });
    expect(diag("A").name).toBe("Actuator A");
    expect(diag("A").physicalAddress).toBe("1.1.1");
    expect(diag("E").configuration!.objects[0]).toMatchObject({ eligible: false, reason: "no_send_group" });
  });
  it("a missing address is reported as missing; a bare device number without area/line context is reported as invalid — never guessed", async () => {
    const r = await boot();
    expect(r.issues.find((i) => i.deviceId === "G")).toMatchObject({ code: "missing_individual_address" });
    const bare = parseEtsProject(new Map([["P-0001/0.xml", Buffer.from(`<KNX><GroupAddresses><GroupRange Name="x"><GroupAddress Id="GA-1" Address="1/1/1" Name="n" DatapointType="DPST-1-1" /></GroupRange></GroupAddresses><Topology><DeviceInstance Id="Z" Name="Z" Address="7" ProductRefId="M-01_H-1_P-1"><ComObjectInstanceRefs /></DeviceInstance></Topology></KNX>`, "utf8")]]));
    const devs = etsDevicesFromModel(bare);
    expect(devs[0]!.individualAddress).toBe("7");
    const r2 = svc.importEts(devs);
    expect(r2.skipped).toEqual([{ deviceId: "Z", code: "invalid_individual_address" }]);
  });
  it("ineligible objects and unregistered devices are never probed", async () => {
    await boot(); startTalking();
    await clock.advance(40 * 60_000);
    const gas = new Set(readsSent().filter((r) => r.c.group?.service === "read").map((r) => r.c.destination));
    const allowed = new Set([GA("1/1/1"), GA("1/1/2"), GA("1/1/20"), GA("1/1/3"), GA("1/1/4")]);
    expect(gas.size).toBeGreaterThan(0);
    for (const g of gas) expect(allowed.has(g)).toBe(true);                       // never E, F, G, H, I, K, L or any write-only object
  });
});

describe("integrated behaviour (simulated)", () => {
  it("responding, silent and intermittent devices are classified from their own evidence, with the method and certainty shown", async () => {
    await boot(); startTalking();
    await clock.advance(15 * 60_000);
    expect(dev("A")).toMatchObject({ state: "online", reason: "active_response", confidence: "high" });
    expect(dev("C")).toMatchObject({ state: "unknown", reason: "unproven_silent" });
    expect(["degraded", "online"]).toContain(dev("D").state);
    expect(dev("K")).toMatchObject({ state: "online", reason: "passive_telegram" });
    expect(dev("L")).toMatchObject({ checkMethod: "passive_only", activeCheck: "disabled" });
    // certainty: a conclusive absence of an answer is NOT the same as an unknown outcome, and neither is a confirmed device failure
    expect(diag("A").evidence.lastCheck).toMatchObject({ outcome: "success", certainty: "confirmed_response" });
    expect(diag("C").evidence.lastCheck).toMatchObject({ outcome: "failure", certainty: "confirmed_no_response" });
    expect(diag("C").humanReason).toMatch(/never answered a status read/);
    expect(diag("C").evidence.consecutiveConclusiveFailures).toBeGreaterThan(0);
  });

  it("an outcome that could not be judged (the line failed) is reported as UNKNOWN, never as a failure or a success", async () => {
    await boot(); startTalking();
    await clock.advance(5 * 60_000);
    bus.lineFault = true;
    await clock.advance(10 * 60_000);
    const checks = svc.diagnostics().devices.map((d) => d.evidence.lastCheck).filter((c) => c !== null && c.outcome === "inconclusive");
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) expect(c!.certainty).toBe("unknown");
    expect(svc.diagnostics().path.bus).toMatch(/degraded|unknown/);
    expect(svc.snapshot().devices.filter((d) => d.state === "offline")).toHaveLength(0);
  });

  it("stale evidence is flagged and decays to unknown — never to offline", async () => {
    await boot();
    wall.emit(bus, GA("2/0/1"), "1.001", true);                                    // K talks once, then never again
    await clock.advance(1_000);
    expect(st("K")).toBe("online/passive_telegram");
    expect(diag("K").evidence.stale).toBe(false);
    await clock.advance(C.passiveFreshnessMs > 180_000 ? 200_000 : 200_000);
    expect(st("K")).toBe("unknown/stale_evidence");
    expect(diag("K")).toMatchObject({ evidence: { stale: true }, humanReason: expect.stringMatching(/does not show that the device is offline/) });
    expect(diag("K").lastTransition).toMatchObject({ to: "unknown/stale_evidence" });
    await clock.advance(24 * 3_600_000);
    expect(dev("K").state).toBe("unknown");
  });

  it("gateway loss and recovery: the supervisor reconnects with a fresh tunnel, devices are unknown/path_down meanwhile (nothing blamed on them), health returns", async () => {
    await boot(); startTalking();
    await clock.advance(6 * 60_000);
    expect(dev("A").state).toBe("online");
    const failedBefore = svc.snapshot().load.checksFailed;
    const created = svc.diagnostics().connection.tunnelsCreated;
    iface.faults.online = false;
    await clock.advance(5 * 60_000);
    expect(svc.diagnostics().path).toMatchObject({ gateway: "unreachable", interface: "down" });
    expect(svc.diagnostics().connection.status).not.toBe("connected");
    expect(st("A")).toBe("unknown/path_down");
    expect(svc.diagnostics().path.summary).toMatch(/down/);
    expect(svc.snapshot().load.checksFailed).toBe(failedBefore);
    iface.faults.online = true;
    await clock.advance(5 * 60_000);
    const d = svc.diagnostics();
    expect(d.connection.status).toBe("connected");
    expect(d.connection.supervisor.successfulReconnects).toBeGreaterThanOrEqual(1);
    expect(d.connection.tunnelsCreated).toBeGreaterThan(created);
    expect(d.connection.attachedTunnels).toBe(1);
    expect(dev("A")).toMatchObject({ state: "online", reason: "active_response" });
    expect(svc.snapshot().devices.filter((x) => x.state === "offline")).toHaveLength(0);
  });

  it("repeated disconnect/reconnect never duplicates subscriptions, timers or monitoring loops", async () => {
    await boot(); startTalking();
    for (let i = 0; i < 4; i++) {
      await clock.advance(3 * 60_000);
      iface.reboot(60_000);                                                        // every tunnel is forgotten; the heartbeat notices and the supervisor reconnects
      await clock.advance(5 * 60_000);
    }
    await clock.advance(5 * 60_000);
    const d = svc.diagnostics();
    expect(d.connection.attachedTunnels).toBe(1);
    expect(d.connection.monitorRunning).toBe(true);
    expect(d.connection.tunnelsCreated).toBeGreaterThanOrEqual(5);
    // one telegram on the line ⇒ exactly one observation (a duplicate subscription would count it twice)
    const before = svc.snapshot().load.telegramsObserved;
    wall.emit(bus, GA("2/0/1"), "1.001", true); await clock.advance(50);
    expect(svc.snapshot().load.telegramsObserved - before).toBe(1);
    // one monitoring loop: only the live tunnel's timers exist besides the monitor tick and the supervisor
    const pendingBefore = clock.pendingTimers;
    await svc.stop();
    await clock.advance(60_000);
    expect(clock.pendingTimers).toBeLessThan(pendingBefore);
  });

  it("probe budgets stay valid across overlapping cycles AND reconnects (spacing, per-minute cap, one check at a time)", async () => {
    const many: EtsDeviceInfo[] = [];
    for (let i = 0; i < 40; i++) {
      const n = 20 + i;
      many.push({ id: `X${i}`, name: `X${i}`, individualAddress: `1.2.${n}`, objects: [{ id: `X${i}-o`, number: 1, text: "S", dpt: "1.001", flags: { read: true, write: false, communicate: true, transmit: true, update: false, readOnInit: false }, sendGroupAddresses: [`4/1/${i}`], receiveGroupAddresses: [] }] });
      const a = new VirtualActuator({ individualAddress: IA(`1.2.${n}`), commandGa: GA(`4/0/${i}`), feedbackGa: GA(`4/1/${i}`), dpt: "1.001", initial: false }, clock);
      bus.addDevice(a);
    }
    svc.importEts(many); await startSvc();
    for (let i = 0; i < 5; i++) { await clock.advance(15 * 60_000); iface.reboot(90_000); }
    await clock.advance(20 * 60_000);
    const reads = readsSent().filter((r) => r.c.group?.service === "read");
    expect(reads.length).toBeGreaterThan(30);
    for (let i = 1; i < reads.length; i++) expect(reads[i]!.t - reads[i - 1]!.t).toBeGreaterThanOrEqual(C.minReadGapMs);
    const perMin = new Map<number, number>();
    for (const r of reads) perMin.set(Math.floor(r.t / 60_000), (perMin.get(Math.floor(r.t / 60_000)) ?? 0) + 1);
    expect(Math.max(...perMin.values())).toBeLessThanOrEqual(C.maxChecksPerMinute * C.maxAttempts);
    expect(svc.snapshot().load.maxConcurrentObserved).toBe(1);
    expect(svc.diagnostics().connection.supervisor.successfulReconnects).toBeGreaterThanOrEqual(3);
  });

  it("a tunnel loss cancels in-flight probes at once (not after their response timeout), stops the monitor, counts nothing — and the supervisor then restores a single attachment", async () => {
    await boot();
    for (let i = 0; i < 6000 && svc.monitor.pendingChecks === 0; i++) await clock.advance(100);
    expect(svc.monitor.pendingChecks).toBeGreaterThan(0);
    const failed = svc.snapshot().load.checksFailed;
    void tunnels.at(-1)!.disconnect();                                             // the tunnel goes away under the probe
    await clock.advance(50);
    expect(svc.monitor.pendingChecks).toBe(0);
    expect(svc.monitor.isRunning).toBe(false);
    expect(svc.diagnostics().connection.attachedTunnels).toBe(0);
    expect(svc.snapshot().load.checksFailed).toBe(failed);
    await clock.advance(60_000);
    expect(svc.diagnostics().connection).toMatchObject({ status: "connected", attachedTunnels: 1, monitorRunning: true });
  });

  it("shutdown with a probe outstanding cancels it, counts nothing, closes the tunnel and leaves no timers or sockets", async () => {
    await boot();
    for (let i = 0; i < 600 && svc.monitor.pendingChecks === 0; i++) await clock.advance(1_000);
    expect(svc.monitor.pendingChecks).toBeGreaterThan(0);                          // a check is genuinely in flight
    const failed = svc.snapshot().load.checksFailed;
    await svc.stop();
    await clock.advance(60_000);
    expect(svc.monitor.pendingChecks).toBe(0);
    expect(svc.monitor.isRunning).toBe(false);
    expect(svc.snapshot().load.checksFailed).toBe(failed);
    expect(svc.diagnostics().connection).toMatchObject({ status: "disconnected", attachedTunnels: 0, monitorRunning: false });
    expect(clock.pendingTimers).toBe(0);
    expect(net.openClientSockets).toBe(0);
    await svc.stop();                                                              // idempotent
  });

  it("READ-ONLY end to end: across probes, outages and reconnects only GroupValueReads ever leave; nothing but reads reaches the line", async () => {
    await boot(); startTalking();
    act["A"]!.online = false;
    for (let i = 0; i < 3; i++) { await clock.advance(6 * 60_000); iface.reboot(60_000); }
    await clock.advance(10 * 60_000);
    const sent = readsSent();
    expect(sent.length).toBeGreaterThan(5);
    for (const s of sent) { expect(s.c.messageCode).toBe(CemiMessageCode.L_DATA_REQ); expect(s.c.group?.service).toBe("read"); }
    expect(bus.history.filter((t) => t.source === 0xff01 && t.service !== "read")).toHaveLength(0);
    expect(Object.getOwnPropertyNames(KnxHealthService.prototype).filter((n) => /^(write|send|command|execute|toggle|dim)/i.test(n))).toEqual([]);
  });

  it("a locally accepted frame is never evidence: with every response suppressed the receipts still resolve but no device becomes online by active evidence", async () => {
    for (const k of ["A", "B", "C", "D"]) act[k]!.faults = { noFeedback: true };
    await boot();
    await clock.advance(30 * 60_000);
    expect(svc.snapshot().load.readsSent).toBeGreaterThan(5);                      // plenty of frames were accepted by the interface
    for (const id of ["A", "B", "C", "D"]) expect(dev(id).lastResponseAt).toBeNull();
    for (const id of ["A", "B", "C", "D"]) expect(dev(id).state).not.toBe("online");
  });
});

describe("ETS re-import reconciliation", () => {
  it("re-importing an identical project changes nothing and keeps all evidence", async () => {
    await boot(); startTalking();
    await clock.advance(10 * 60_000);
    const before = JSON.stringify(svc.snapshot().devices.map((d) => [d.deviceId, d.lastSeenAt, d.lastResponseAt, d.consecutiveFailures, d.activeCheck]));
    const r = svc.importEts(etsDevicesFromModel(model(BASE)), { secureDeviceIds: SECURE });
    expect(r.added).toEqual([]); expect(r.updated).toEqual([]); expect(r.removed).toEqual([]);
    expect(r.unchanged.sort()).toEqual(["A", "B", "C", "D", "E", "F", "K", "L"]);
    expect(JSON.stringify(svc.snapshot().devices.map((d) => [d.deviceId, d.lastSeenAt, d.lastResponseAt, d.consecutiveFailures, d.activeCheck]))).toBe(before);
    expect(svc.monitor.registeredDevices()).toHaveLength(8);                       // no duplicates
  });
  it("a changed project is reconciled: new device added, removed device dropped, changed status group updated with evidence kept, changed address resets only that device", async () => {
    await boot(); startTalking();
    await clock.advance(10 * 60_000);
    const aSeen = dev("A").lastSeenAt; const kSeen = dev("K").lastSeenAt;
    expect(aSeen).not.toBeNull();
    const next: Dev[] = BASE.filter((d) => d.id !== "C" && d.id !== "D").map((d) => d.id === "A"
      ? { ...d, objs: [d.objs[0]!, { n: 2, text: "Switch Status", r: true, t: true, send: ["1/1/2"], recv: [] }] }       // A now answers on another GA (B's) — group set changed
      : d.id === "K" ? { ...d, addr: "13" } : d);                                                                      // K moved to another physical address
    next.push({ id: "M", name: "New M", addr: "14", objs: [{ n: 1, text: "S", r: true, send: ["1/1/6"] }] });
    const r = svc.importEts(etsDevicesFromModel(model(next)), { secureDeviceIds: SECURE });
    expect(r.added).toEqual(["M"]);
    expect(r.removed.sort()).toEqual(["C", "D"]);
    expect(r.updated.sort()).toEqual(["A", "K"]);
    expect(r.evidenceReset).toEqual(["K"]);
    expect(dev("K").lastSeenAt).toBeNull();                                        // attributed by the OLD address ⇒ discarded
    expect(dev("A").lastSeenAt).toBe(aSeen);                                       // kept
    expect(dev("A").activeCheck).toBe("candidate");                                // proven only for the previous group set
    expect(svc.monitor.registeredDevices().map((d) => d.deviceId).sort()).toEqual(["A", "B", "E", "F", "K", "L", "M"]);
    void kSeen;
  });
  it("an ETS id change with the same physical address keeps the evidence (rename), without a duplicate", async () => {
    await boot(); startTalking();
    await clock.advance(10 * 60_000);
    const seen = dev("A").lastSeenAt;
    const next = BASE.map((d) => d.id === "A" ? { ...d, id: "A2" } : d);
    const r = svc.importEts(etsDevicesFromModel(model(next)), { secureDeviceIds: SECURE });
    expect(r.renamed).toEqual([{ from: "A", to: "A2" }]);
    expect(dev("A2").lastSeenAt).toBe(seen);
    expect(svc.snapshot().devices.some((d) => d.deviceId === "A")).toBe(false);
    expect(svc.monitor.registeredDevices().filter((d) => d.individualAddress === IA("1.1.1"))).toHaveLength(1);
  });
  it("importing while running registers new devices without restarting anything", async () => {
    await boot();
    const created = svc.diagnostics().connection.tunnelsCreated;
    svc.importEts(etsDevicesFromModel(model([...BASE, { id: "N", name: "N", addr: "15", objs: [{ n: 1, text: "S", r: true, send: ["1/1/6"] }] }])), { secureDeviceIds: SECURE });
    await clock.advance(10 * 60_000);
    expect(svc.diagnostics().connection.tunnelsCreated).toBe(created);
    expect(dev("N").state).toBe("unknown");
  });
});

describe("diagnostics document", () => {
  it("carries identity, state, confidence, evidence, timestamps, latency, failures, staleness, path context, last transition and human reasons", async () => {
    await boot(); startTalking();
    await clock.advance(10 * 60_000);
    const d = svc.diagnostics();
    expect(d.schema).toBe("knx.health.diagnostics.v1");
    expect(d.evidenceLevel).toBe("simulator-tested");
    expect(d.assumptions.join(" ")).toMatch(/cEMI/);
    expect(d.connection).toMatchObject({ status: "connected", gateway: { host: GW, port: 3671 } });
    expect(d.connection.driver).toMatchObject({ connectionStatus: "connected", protocol: "knx", ip: GW });
    expect(d.path).toMatchObject({ gateway: "reachable", interface: "up" });
    const a = d.devices.find((x) => x.deviceId === "A")!;
    expect(a).toMatchObject({ physicalAddress: "1.1.1", state: "online", confidence: "high", reason: "active_response" });
    expect(a.humanReason).toMatch(/answered a status read/);
    expect(a.evidence).toMatchObject({ method: "group_read", lastEvidenceKind: "active_response", activeCheck: "proven", stale: false, statusGroups: ["1/1/1"] });
    expect(a.evidence.lastSuccessfulResponseAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(a.evidence.lastResponseLatencyMs).toBeGreaterThanOrEqual(0);
    expect(a.lastTransition).toMatchObject({ to: "online/active_response" });
    expect(a.lastTransition!.summary).toMatch(/state changed to online/);
    expect(d.events.some((e) => e.kind === "state_change" && e.deviceId === "A")).toBe(true);
    expect(d.registration).toMatchObject({ added: 8, skipped: 3 });
    expect(d.registration!.issues.length).toBeGreaterThan(3);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);                              // JSON-safe, no Maps/Secrets/functions
  });
  it("contains no credential, key or secure-session material", async () => {
    await boot(); startTalking();
    await clock.advance(5 * 60_000);
    const json = JSON.stringify(svc.diagnostics());
    expect(json).not.toMatch(/password|passphrase|secret|credential|token|private|keyring|fdsk|authentication.?code|session.?key/i);
  });
});
