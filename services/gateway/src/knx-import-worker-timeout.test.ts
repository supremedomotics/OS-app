import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  InMemoryProtocolBindingStore,
  DriverBindingEngine,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import { SupremeKnxDriver, type IKnxProvider, type KnxProviderDiagnostics, type KnxProviderHealth, type KnxTask } from "@supreme/protocols";

/**
 * § 111s-hang investigation — regression test for the worker-completion wait's bounded
 * timeout (`InstallerServices.knxInstallerQueueThreaded`). Before this fix, a worker that
 * never posted a message/error/exit left the job stuck in "running" forever; there was no
 * way for it to ever become diagnosable. This mocks `node:worker_threads`'s `Worker` as an
 * EventEmitter that never emits anything, so the real ETS parsing pipeline never runs —
 * the test only proves the TIMEOUT PATH itself, which is why this lives in its own file
 * (mocking the module here must not affect `knx-installer-workflow.e2e.test.ts`'s tests,
 * which need the REAL worker actually doing real parsing).
 */
class MockWorker extends EventEmitter {
  terminated = false;
  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}
let lastWorker: MockWorker | null = null;
vi.mock("node:worker_threads", () => ({
  Worker: class {
    constructor() {
      lastWorker = new MockWorker();
      return lastWorker as unknown as InstanceType<typeof MockWorker>;
    }
  },
}));

class FakeKnx implements INativeProtocolDriver {
  readonly protocol = "knx";
  private readonly devices = new Set<DeviceId>();
  private readonly listeners = new Set<StateListener>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(_id: DeviceId, _c: CapabilityCommand): Promise<void> {}
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> { return []; }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

class FakeEmptyKnxIotProvider implements IKnxProvider {
  readonly name = "fake-empty-knx-iot";
  async initialize(): Promise<void> {}
  async discover(): Promise<DiscoveredDevice[]> { return []; }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async execute(_task: KnxTask): Promise<unknown> { throw new Error("not applicable"); }
  subscribe(): void { throw new Error("not applicable"); }
  unsubscribe(): void {}
  health(): KnxProviderHealth { return { connected: true, lastError: null }; }
  diagnostics(): KnxProviderDiagnostics {
    return { provider: this.name, connected: true, packetsSent: 0, packetsReceived: 0, lastTelegramAt: null, lastCommandAt: null, lastError: null, reconnectAttempts: 0 };
  }
}

describe("KNX ETS import worker — bounded completion timeout (§ 111s-hang fix)", () => {
  let app: FastifyInstance;
  let ctx: import("./context.js").AppContext;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    const { AppContext } = await import("./context.js");
    const { loadConfig } = await import("./config.js");
    const { buildServer } = await import("./server.js");

    const registry = new EntityRegistryMirror();
    const engine = new SupremeNativeAdapter({ drivers: [new FakeKnx()] });
    const providers = new ProviderRegistry();
    const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore: new InMemoryProtocolBindingStore(),
      knxDiscoveryDriverFactory: (config) => new SupremeKnxDriver({ ...config, iotProvider: new FakeEmptyKnxIotProvider() }),
      knxWorkerTimeoutMs: 100, // fast for the test — production default is 5 minutes
    });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    token = ((await res.json()) as { accessToken: string }).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  it("fails the job (instead of hanging forever) when the worker never posts a result", async () => {
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const jobRes = await fetch(`${baseUrl}/v1/commissioning/knx/queue/job`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ gateway: { host: "127.0.0.1" }, content: "<GroupAddress-Export></GroupAddress-Export>" }),
    });
    expect(jobRes.status).toBe(202);
    const { jobId } = (await jobRes.json()) as { jobId: string };

    type Job = { status: string; error: string | null };
    let job: Job | null = null;
    for (let n = 0; n < 200; n++) {
      const res = await fetch(`${baseUrl}/v1/commissioning/knx/queue/job/${jobId}`, { headers: auth });
      job = (await res.json()) as Job;
      if (job.status === "failed" || job.status === "completed") break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/did not finish within|100ms|terminated/);
    expect(lastWorker?.terminated).toBe(true);
  }, 10000);
});
