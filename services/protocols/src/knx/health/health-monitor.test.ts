import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../native/simulator/index.js";
import { DEFAULT_HEALTH_CONFIG as C, type HealthConfig } from "./health-model.js";
import { KnxHealthMonitor, monitoredDeviceFromEts, type ReadOnlyGroupBus } from "./health-monitor.js";

/** Deterministic monitor behaviour with a scripted bus — no simulator, no wall time. Everything here is a MODEL of devices; see health-simulator.test.ts for the tunnel-level runs. */
const IA = (n: number) => 0x1100 + n;
const GA = (n: number) => 0x0900 + n;

let clock: ManualClock;
let reads: Array<{ at: number; ga: number }>;
let respond: (ga: number) => void;
let refuse: boolean;
let monitor: KnxHealthMonitor;

class ScriptedBus implements ReadOnlyGroupBus {
  async readGroup(ga: number): Promise<void> {
    if (refuse) throw new Error("interface refused the frame");
    reads.push({ at: clock.now(), ga });
    respond(ga);
  }
}
/** A device that answers reads on its status group after `delay` ms, as long as `up()` holds. */
const answers = (map: Map<number, { ia: number; delay: number; up: () => boolean }>) => (ga: number): void => {
  const d = map.get(ga);
  if (d && d.up()) clock.setTimeout(() => monitor.observeTelegram({ source: d.ia, destination: ga, service: "response" }), d.delay);
};
const make = (over: Partial<HealthConfig> = {}) => { monitor = new KnxHealthMonitor(clock, new ScriptedBus(), over); return monitor; };
const up = () => monitor.setPath({ gateway: "reachable", interface: "up" });
const dev = (id: string) => monitor.snapshot().devices.find((d) => d.deviceId === id)!;
const st = (id: string) => { const d = dev(id); return `${d.state}/${d.reason}`; };

beforeEach(() => { clock = new ManualClock(); reads = []; refuse = false; respond = () => undefined; });
afterEach(async () => { monitor.stop(); await clock.advance(1000); expect(clock.pendingTimers).toBe(0); });

describe("registration", () => {
  it("rejects duplicates and bad addresses", () => {
    make();
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    expect(() => monitor.registerDevice({ deviceId: "a", individualAddress: IA(2) })).toThrow(/already registered/);
    expect(() => monitor.registerDevice({ deviceId: "b", individualAddress: IA(1) })).toThrow(/already monitored/);
    expect(() => monitor.registerDevice({ deviceId: "c", individualAddress: 70000 })).toThrow(/out of range/);
  });
  it("derives status groups from ETS data: only objects with the Read flag, only the groups the device sends on; secure ⇒ never probed; garbage skipped", () => {
    const d = monitoredDeviceFromEts({
      id: "x", individualAddress: "1.1.5",
      comObjects: [
        { flags: { read: true }, sendGroupAddresses: ["1/1/2", "bad"] },
        { flags: { read: false }, sendGroupAddresses: ["1/1/1"] },
        { flags: { read: true }, sendGroupAddresses: ["1/1/2", "2/0/7"] },
      ],
    });
    expect(d.individualAddress).toBe(0x1105);
    expect(d.statusGroups).toEqual([0x0902, 0x1007]);
    expect(d.activeCheck).toBe("allowed");
    expect(monitoredDeviceFromEts({ id: "s", individualAddress: "1.1.6", comObjects: [] }, { secure: true }).activeCheck).toBe("disabled");
    expect(monitoredDeviceFromEts({ id: "n", individualAddress: "nonsense", comObjects: [] }).individualAddress).toBeNull();
  });
});

describe("passive observation", () => {
  it("any telegram whose source is the device ⇒ online (medium confidence); other sources are not attributed", () => {
    make(); up();
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1) });
    expect(st("a")).toBe("unknown/no_evidence");
    monitor.observeTelegram({ source: IA(9), destination: GA(1), service: "write" });
    expect(st("a")).toBe("unknown/no_evidence");
    monitor.observeTelegram({ source: IA(1), destination: GA(1), service: "write" });
    expect(st("a")).toBe("online/passive_telegram");
    expect(dev("a").confidence).toBe("medium");
    expect(dev("a").lastSeenKind).toBe("passive_telegram");
    expect(dev("a").checkMethod).toBe("passive_only");
  });
  it("a chatty device is never probed: no reads are sent while passive evidence is younger than the check interval", async () => {
    make({ checkIntervalMs: 60_000 }); up(); respond = answers(new Map());
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.start();
    for (let i = 0; i < 40; i++) { monitor.observeTelegram({ source: IA(1), destination: GA(1), service: "write" }); await clock.advance(30_000); }
    expect(reads).toHaveLength(0);
    expect(dev("a").state).toBe("online");
  });
  it("a response seen on its status group (answering someone else's read) proves the object answers reads", () => {
    make(); up();
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.observeTelegram({ source: IA(1), destination: GA(1), service: "response" });
    expect(dev("a").activeCheck).toBe("proven");
  });
});

describe("active checks", () => {
  it("a responsive device is probed once its first slot arrives; the answer is high-confidence evidence with a measured latency", async () => {
    make(); up(); respond = answers(new Map([[GA(1), { ia: IA(1), delay: 40, up: () => true }]]));
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.start();
    await clock.advance(C.checkIntervalMs + C.tickMs + 100);
    expect(reads).toHaveLength(1);
    expect(st("a")).toBe("online/active_response");
    expect(dev("a")).toMatchObject({ confidence: "high", lastResponseLatencyMs: 40, consecutiveFailures: 0, activeCheck: "proven", checkMethod: "group_read" });
    expect(dev("a").lastCheck?.outcome).toBe("success");
  });
  it("a cycle makes at most maxAttempts reads (rotating over the device's status groups) and counts as ONE failure", async () => {
    make({ checkIntervalMs: 10_000 }); up();
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1), GA(2)] });
    monitor.observeTelegram({ source: IA(1), destination: GA(1), service: "response" });   // proven, last heard at t=0
    monitor.start();
    await clock.advance(25_000);                                                           // first cycle only (next one is failureRecheckMs = 60 s away)
    expect(reads).toHaveLength(C.maxAttempts);
    expect(new Set(reads.map((r) => r.ga)).size).toBe(2);
    expect(dev("a").consecutiveFailures).toBe(1);
    expect(dev("a").state).toBe("degraded");
  });
  it("a response within the timeout succeeds on the retry: attempt 1 lost, attempt 2 answered", async () => {
    make({ checkIntervalMs: 10_000 }); up(); let n = 0;
    respond = (ga) => { if (++n === 2) clock.setTimeout(() => monitor.observeTelegram({ source: IA(1), destination: ga, service: "response" }), 20); };
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.start();
    await clock.advance(15_000);
    expect(reads).toHaveLength(2);
    expect(st("a")).toBe("online/active_response");
    expect(dev("a").consecutiveFailures).toBe(0);
  });
  it("a slow answer (inside the timeout) is degraded/slow_response; a faster one later restores online", async () => {
    make({ checkIntervalMs: 10_000 }); up(); let delay = 2_500;
    respond = (ga) => clock.setTimeout(() => monitor.observeTelegram({ source: IA(1), destination: ga, service: "response" }), delay);
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.start();
    await clock.advance(15_000);
    expect(st("a")).toBe("degraded/slow_response");
    delay = 30;
    await clock.advance(C.activeFreshnessMs);   // evidence ages, next probe is fast
    await clock.advance(30_000);
    expect(st("a")).toBe("online/active_response");
  });
  it("a late answer after the cycle ended is still evidence of life: the failure streak resets and the device is online again", async () => {
    make({ checkIntervalMs: 10_000, responseTimeoutMs: 1_000, maxAttempts: 1 }); up();
    respond = (ga) => clock.setTimeout(() => monitor.observeTelegram({ source: IA(1), destination: ga, service: "response" }), 1_500);
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.observeTelegram({ source: IA(1), destination: GA(1), service: "response" });   // proven
    monitor.start();
    await clock.advance(15_000);
    expect(dev("a").consecutiveFailures).toBe(0);
    expect(dev("a").state).toBe("online");
  });
  it("a device that speaks DURING an unanswered cycle is not failed for it: the cycle is recorded as inconclusive", async () => {
    make({ checkIntervalMs: 10_000, responseTimeoutMs: 1_000 }); up(); respond = () => undefined;
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.observeTelegram({ source: IA(1), destination: GA(1), service: "response" });   // proven
    monitor.start();
    const spoke = clock.setTimeout(function poll() { if (reads.length === 1) monitor.observeTelegram({ source: IA(1), destination: GA(5), service: "write" }); else clock.setTimeout(poll, 100); }, 100);
    void spoke;
    await clock.advance(25_000);
    expect(monitor.events().some((e) => e.kind === "check" && e.reason === "device_spoke_during_check")).toBe(true);
    expect(dev("a").consecutiveFailures).toBe(0);
  });
});

describe("state transitions and recovery", () => {
  function scenario() {
    make({ checkIntervalMs: 120_000 }); up();
    let alive = true;
    respond = answers(new Map([[GA(1), { ia: IA(1), delay: 30, up: () => alive }]]));
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.start();
    return { kill: () => { alive = false; }, revive: () => { alive = true; } };
  }
  it("online → degraded → offline when a proven device stops answering AND stays silent; offline is reached only after the silence window", async () => {
    const s = scenario();
    await clock.advance(130_000);
    expect(st("a")).toBe("online/active_response");
    const t0 = dev("a").lastSeenAt!;
    s.kill();
    const seen: string[] = [];
    monitor.onEvent((e) => { if (e.kind === "state_change") seen.push(e.to!); });
    await clock.advance(C.offlineMinSilenceMs + 5 * 60_000);
    expect(seen.map((x) => x.split("/")[0])).toEqual(["unknown", "degraded", "offline"].filter((x) => seen.map((y) => y.split("/")[0]).includes(x)));
    expect(seen.some((x) => x.startsWith("degraded/active_checks_failed"))).toBe(true);
    const off = monitor.events().filter((e) => e.kind === "state_change" && e.to === "offline/active_checks_failed").at(-1)!;
    expect(off.at - t0).toBeGreaterThanOrEqual(C.offlineMinSilenceMs);
    expect(dev("a")).toMatchObject({ state: "offline", confidence: "high", reason: "active_checks_failed" });
    expect(dev("a").consecutiveFailures).toBeGreaterThanOrEqual(C.offlineAfterFailures);
  });
  it("recovery by active probe: an offline device is still probed (slowly) and returns to online", async () => {
    const s = scenario();
    await clock.advance(130_000); s.kill();
    await clock.advance(C.offlineMinSilenceMs + 10 * 60_000);
    expect(dev("a").state).toBe("offline");
    const readsWhileOffline = reads.length;
    s.revive();
    await clock.advance(C.offlineProbeIntervalMs + 20_000);
    expect(reads.length).toBeGreaterThan(readsWhileOffline);
    expect(st("a")).toBe("online/active_response");
    expect(dev("a").consecutiveFailures).toBe(0);
  });
  it("recovery by passive evidence is immediate, without waiting for a probe", async () => {
    const s = scenario();
    await clock.advance(130_000); s.kill();
    await clock.advance(C.offlineMinSilenceMs + 10 * 60_000);
    expect(dev("a").state).toBe("offline");
    monitor.observeTelegram({ source: IA(1), destination: GA(7), service: "write" });
    expect(st("a")).toBe("online/passive_telegram");
    expect(dev("a").consecutiveFailures).toBe(0);
  });
  it("an offline device is probed no more often than offlineProbeIntervalMs (no hammering)", async () => {
    const s = scenario();
    await clock.advance(130_000); s.kill();
    await clock.advance(C.offlineMinSilenceMs + 10 * 60_000);
    const mark = reads.length; const t = clock.now();
    await clock.advance(3 * C.offlineProbeIntervalMs);
    const cycles = (reads.length - mark) / C.maxAttempts;
    expect(cycles).toBeLessThanOrEqual(3 + 1);
    expect(clock.now() - t).toBe(3 * C.offlineProbeIntervalMs);
  });
});

describe("false-offline prevention", () => {
  it("a silent device that has NEVER answered a read is never offline or degraded — however long it stays silent", async () => {
    make({ checkIntervalMs: 60_000 }); up(); respond = () => undefined;
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.observeTelegram({ source: IA(1), destination: GA(9), service: "write" });
    monitor.start();
    await clock.advance(6 * 3_600_000);
    expect(["unknown"]).toContain(dev("a").state);
    expect(dev("a").reason).toBe("unproven_silent");
    expect(dev("a").activeCheck).toBe("candidate");
  });
  it("one lost read of a proven device is a degradation, not an outage", async () => {
    make({ checkIntervalMs: 10_000 }); up(); let ok = true;
    respond = (ga) => { if (ok) clock.setTimeout(() => monitor.observeTelegram({ source: IA(1), destination: ga, service: "response" }), 20); };
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.start();
    await clock.advance(15_000); expect(dev("a").state).toBe("online");
    ok = false;
    await clock.advance(C.activeFreshnessMs - 30_000 > 0 ? 40_000 : 40_000);
    ok = true;
    await clock.advance(C.failureRecheckMs + 20_000);
    expect(dev("a").state).not.toBe("offline");
  });
  it("gateway loss: probing stops, devices go unknown/path_down, no failure is counted, and nothing is offline after the link returns", async () => {
    make({ checkIntervalMs: 10_000 }); up(); let alive = true;
    respond = (ga) => { if (alive) clock.setTimeout(() => monitor.observeTelegram({ source: IA(1), destination: ga, service: "response" }), 20); };
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.start();
    await clock.advance(15_000);
    expect(dev("a").state).toBe("online");
    alive = false; monitor.setPath({ gateway: "unreachable", interface: "down" });
    await clock.advance(2 * 3_600_000);
    expect(st("a")).toBe("unknown/path_down");
    expect(dev("a").consecutiveFailures).toBe(0);
    alive = true; up();
    await clock.advance(C.failureRecheckMs * 2);
    expect(dev("a").state).toBe("online");
  });
  it("the path breaking MID-CYCLE makes that cycle inconclusive (not a failure)", async () => {
    make({ checkIntervalMs: 10_000, responseTimeoutMs: 3_000 }); up(); respond = () => undefined;
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.observeTelegram({ source: IA(1), destination: GA(1), service: "response" });   // proven
    monitor.start();
    const t = clock.setTimeout(function brk() { if (reads.length >= 1) monitor.setPath({ gateway: "unreachable" }); else clock.setTimeout(brk, 100); }, 100);
    void t;
    await clock.advance(25_000);
    expect(dev("a").consecutiveFailures).toBe(0);
    expect(monitor.snapshot().load.checksFailed).toBe(0);
    expect(monitor.snapshot().load.checksInconclusive).toBeGreaterThan(0);
  });
  it("a refused read (interface said no) is inconclusive: it never counts against the device", async () => {
    make({ checkIntervalMs: 10_000 }); up(); refuse = true;
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.observeTelegram({ source: IA(1), destination: GA(1), service: "response" });
    monitor.start();
    await clock.advance(C.passiveFreshnessMs + 20 * 60_000);
    expect(dev("a").consecutiveFailures).toBe(0);
    expect(monitor.snapshot().load.checksInconclusive).toBeGreaterThan(0);
    expect(monitor.snapshot().load.checksFailed).toBe(0);
  });
  it("bus trouble (consecutive bus_error outcomes) suspends probing and is never blamed on devices; any line traffic ends the verdict", async () => {
    make({ checkIntervalMs: 10_000 }); up();
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.observeTelegram({ source: IA(1), destination: GA(1), service: "response" });
    for (let i = 0; i < C.busErrorThreshold; i++) monitor.noteSendOutcome("bus_error");
    expect(monitor.snapshot().path.bus).toBe("degraded");
    expect(st("a")).toBe("unknown/bus_degraded");
    monitor.start();
    await clock.advance(C.busFreshnessMs - 60_000);
    expect(reads).toHaveLength(0);                                    // probing suspended while the bus verdict stands
    monitor.observeTelegram({ source: IA(77), destination: GA(3), service: "write" });
    expect(monitor.snapshot().path.bus).toBe("ok");
  });
  it("a bus_error verdict expires on its own so probing can resume even on a silent line", async () => {
    make(); up();
    for (let i = 0; i < C.busErrorThreshold; i++) monitor.noteSendOutcome("bus_error");
    expect(monitor.snapshot().path.bus).toBe("degraded");
    await clock.advance(C.busFreshnessMs + 1);
    expect(monitor.snapshot().path.bus).toBe("unknown");
  });
  it("not_confirmed is ambiguous and changes nothing; confirmed clears the error streak", () => {
    make(); up();
    monitor.noteSendOutcome("bus_error"); monitor.noteSendOutcome("bus_error");
    monitor.noteSendOutcome("not_confirmed");
    monitor.noteSendOutcome("bus_error");
    expect(monitor.snapshot().path.bus).toBe("degraded");
    monitor.noteSendOutcome("confirmed");
    expect(monitor.snapshot().path.bus).toBe("ok");
  });
});

describe("staleness", () => {
  it("evidence ages into unknown/stale_evidence and never into offline", async () => {
    make(); up();
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1) });   // not checkable: passive only
    monitor.observeTelegram({ source: IA(1), destination: GA(1), service: "write" });
    expect(dev("a").state).toBe("online");
    await clock.advance(C.passiveFreshnessMs + 1);
    expect(st("a")).toBe("unknown/stale_evidence");
    await clock.advance(30 * 86_400_000);
    expect(st("a")).toBe("unknown/stale_evidence");
  });
});

describe("monitoring load and interference", () => {
  const fleet = (n: number) => {
    const map = new Map<number, { ia: number; delay: number; up: () => boolean }>();
    for (let i = 0; i < n; i++) {
      monitor.registerDevice({ deviceId: `d${String(i).padStart(3, "0")}`, individualAddress: IA(i), statusGroups: [GA(i)] });
      map.set(GA(i), { ia: IA(i), delay: 25, up: () => true });
    }
    respond = answers(map);
  };
  it("300 devices over 3 simulated hours: cycle rate, read spacing and concurrency stay within the configured limits", async () => {
    make(); up(); fleet(300); monitor.start();
    await clock.advance(3 * 3_600_000);
    const perMinute = new Map<number, number>();
    for (const r of reads) perMinute.set(Math.floor(r.at / 60_000), (perMinute.get(Math.floor(r.at / 60_000)) ?? 0) + 1);
    expect(Math.max(...perMinute.values())).toBeLessThanOrEqual(C.maxChecksPerMinute * C.maxAttempts);
    for (let i = 1; i < reads.length; i++) expect(reads[i]!.at - reads[i - 1]!.at).toBeGreaterThanOrEqual(C.minReadGapMs);
    expect(monitor.snapshot().load.maxConcurrentObserved).toBeLessThanOrEqual(C.maxConcurrentChecks);
    expect(reads.length).toBeLessThanOrEqual(3 * 60 * C.maxChecksPerMinute * C.maxAttempts);
    const snap = monitor.snapshot();
    const online = snap.devices.filter((d) => d.state === "online").length;
    expect(online).toBeGreaterThan(60);                                                                       // the checks do work …
    expect(online).toBeLessThanOrEqual(Math.ceil(C.maxChecksPerMinute * (C.activeFreshnessMs / 60_000)) + 1);   // … but the budget bounds how many can be fresh at once
    expect(snap.devices.filter((d) => d.state === "offline")).toHaveLength(0);                                // the rest ages to unknown/stale, never offline
    expect(snap.devices.filter((d) => d.reason === "stale_evidence").length).toBeGreaterThan(100);
    expect(snap.load.overdueChecks).toBeGreaterThan(100);                                                     // and the saturation is observable
  });
  it("the minimum gap between ANY two reads holds even when ticks are fast, several checks are allowed per tick and retries are configured shorter", async () => {
    make({ minReadGapMs: 20_000, tickMs: 1_000, maxChecksPerTick: 5, maxChecksPerMinute: 1000, maxConcurrentChecks: 5, retryDelayMs: 500, checkIntervalMs: 30_000 });
    up(); fleet(10); respond = () => undefined; monitor.start();
    await clock.advance(30 * 60_000);
    expect(reads.length).toBeGreaterThan(10);
    for (let i = 1; i < reads.length; i++) expect(reads[i]!.at - reads[i - 1]!.at).toBeGreaterThanOrEqual(20_000);
  });
  it("devices that talk on their own cost the bus nothing", async () => {
    make({ checkIntervalMs: 120_000 }); up(); fleet(50); monitor.start();
    let talking = true;
    clock.setTimeout(function again() { for (let i = 0; i < 50; i++) monitor.observeTelegram({ source: IA(i), destination: GA(i), service: "write" }); if (talking) clock.setTimeout(again, 60_000); }, 0);
    await clock.advance(3_600_000);
    talking = false;
    expect(reads).toHaveLength(0);
    expect(monitor.snapshot().devices.every((d) => d.state === "online")).toBe(true);
    monitor.stop();
    await clock.advance(120_000);
  });
  it("control traffic keeps probes out of the way: continuous commands ⇒ zero reads; probing resumes after the quiet window", async () => {
    make(); up(); fleet(20); monitor.start();
    let stopCmds = false;
    const loop = (): void => { if (stopCmds) return; monitor.noteControlTraffic(); clock.setTimeout(loop, 2_000); };
    loop();
    await clock.advance(20 * 60_000);
    expect(reads).toHaveLength(0);
    expect(monitor.snapshot().load.ticksDeferredForControlTraffic).toBeGreaterThan(100);
    stopCmds = true;
    await clock.advance(10 * 60_000);
    expect(reads.length).toBeGreaterThan(0);
  });
  it("after a gateway outage there is no probe storm: recovery resumes at the configured rate", async () => {
    make(); fleet(120);
    monitor.setPath({ gateway: "unreachable", interface: "down" });
    monitor.start();
    await clock.advance(2 * 3_600_000);
    expect(reads).toHaveLength(0);                                    // nothing is probed while the path is down
    up();
    const t = clock.now();
    await clock.advance(5 * 60_000);
    const burst = reads.filter((r) => r.at - t < 60_000).length;
    expect(burst).toBeLessThanOrEqual(C.maxChecksPerMinute * C.maxAttempts);
  });
});

describe("safety and lifecycle", () => {
  it("devices that are disabled (e.g. Data Secure) or have no status group are never probed", async () => {
    make({ checkIntervalMs: 10_000 }); up();
    monitor.registerDevice({ deviceId: "sec", individualAddress: IA(1), statusGroups: [GA(1)], activeCheck: "disabled" });
    monitor.registerDevice({ deviceId: "nog", individualAddress: IA(2), statusGroups: [] });
    monitor.registerDevice({ deviceId: "noia", individualAddress: null, statusGroups: [GA(3)] });
    monitor.start();
    await clock.advance(3_600_000);
    expect(reads).toHaveLength(0);
    expect(dev("sec").activeCheck).toBe("disabled");
    expect(dev("nog").activeCheck).toBe("not_available");
    expect(dev("sec").nextCheckAt).toBeNull();
  });
  it("the monitor has no write path: its bus port is read-only and its public surface contains no command method", () => {
    make();
    const names = Object.getOwnPropertyNames(KnxHealthMonitor.prototype);
    expect(names.filter((n) => /^(write|send|command|execute|issue|transmit|toggle|dim)/i.test(n))).toEqual([]);
  });
  it("stop() leaves no timers, even mid-check, and unregistering mid-check records nothing", async () => {
    make({ checkIntervalMs: 5_000 }); up(); respond = () => undefined;
    monitor.registerDevice({ deviceId: "a", individualAddress: IA(1), statusGroups: [GA(1)] });
    monitor.registerDevice({ deviceId: "b", individualAddress: IA(2), statusGroups: [GA(2)] });
    monitor.start();
    await clock.advance(7_000);
    expect(monitor.pendingChecks).toBeGreaterThan(0);
    monitor.unregisterDevice("a");
    monitor.stop();
    await clock.advance(30_000);
    expect(monitor.pendingChecks).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    expect(monitor.snapshot().devices.map((d) => d.deviceId)).toEqual(["b"]);
    expect(dev("b").consecutiveFailures).toBe(0);                      // the aborted cycle was not counted
  });
  it("start() is idempotent and the event log is bounded", async () => {
    make({ eventLogSize: 10 }); up();
    monitor.start(); monitor.start();
    for (let i = 0; i < 40; i++) monitor.setPath({ gateway: i % 2 ? "reachable" : "unreachable" });
    expect(monitor.events().length).toBeLessThanOrEqual(10);
  });
});
